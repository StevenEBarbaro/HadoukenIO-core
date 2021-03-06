
import { Identity, ProviderIdentity, EventPayload } from '../../shapes';
import ofEvents from '../of_events';
import route from '../../common/route';
import { RemoteAck, AckFunc, NackFunc } from '../api_protocol/transport_strategy/ack';
import { sendToIdentity } from '../api_protocol/api_handlers/api_protocol_base';
import { getExternalOrOfWindowIdentity } from '../core_state';

const channelMap: Map<string, ProviderIdentity> = new Map();
const remoteAckMap: Map<string, RemoteAck> = new Map();
const pendingChannelConnections: Map<string, any[]> = new Map();

const CHANNEL_APP_ACTION = 'process-channel-message';
const CHANNEL_ACK_ACTION = 'send-channel-result';
const CHANNEL_CONNECT_ACTION = 'process-channel-connection';

interface AckToSender {
    action: string;
    payload: {
        correlationId: number;
        destinationToken: Identity;
        payload: ProviderIdentity&any;
        success: boolean
    };
}

const getAckKey = (id: number, identity: Identity): string => {
    return `${ id }-${ identity.uuid }-${ identity.name }`;
};

const getChannelId = (uuid: string, name: string, channelName: string): string => {
    return `${uuid}/${name}/${channelName}`;
};

const createAckToSender = (identity: Identity, messageId: number, providerIdentity: ProviderIdentity): AckToSender => {
    return {
        action: CHANNEL_ACK_ACTION,
        payload: {
            correlationId: messageId,
            destinationToken: identity,
            payload: providerIdentity,
            success: true
        }
    };
};

const createChannelTeardown = (providerIdentity: ProviderIdentity): void => {
    // When channel exits, remove from channelMap
    const { uuid, name, isExternal, channelId } = providerIdentity;
    const closedEvent = isExternal ? route.externalApplication('closed', uuid) : route.window('closed', uuid, name);
    ofEvents.once(closedEvent, () => {
        channelMap.delete(channelId);
        ofEvents.emit(route.channel('channel-disconnected'), providerIdentity);
    });

    // For some reason this is captured sometimes when window closed is not
    ofEvents.once(route.application('closed', uuid), () => channelMap.delete(channelId));
};

export module Channel {
    export function addEventListener(targetIdentity: Identity, type: string, listener: (eventPayload: EventPayload) => void) : () => void {
        const { uuid, name } = targetIdentity;
        const eventString = name ? route.channel(type, uuid, name) : route.channel(type, uuid);
        ofEvents.on(eventString, listener);

        return () => {
            ofEvents.removeListener(eventString, listener);
        };
    }

    export function getChannelByChannelId(channelId: string): ProviderIdentity {
        return channelMap.get(channelId);
    }

    export function getAllChannels(): ProviderIdentity[] {
        const allChannels: ProviderIdentity[] = [];
        channelMap.forEach(channel => {
            allChannels.push(channel);
        });
        return allChannels;
    }

    export function getChannelByIdentity(identity: Identity): ProviderIdentity[] {
        const { uuid, name } = identity;
        const providerIdentity: ProviderIdentity[] = [];
        channelMap.forEach(channel => {
            if (channel.uuid === uuid) {
                if (!name) {
                    providerIdentity.push(channel);
                } else if (channel.name === name) {
                    providerIdentity.push(channel);
                }
            }
        });
        return providerIdentity;
    }

    export function getChannelByChannelName(channelName: string): ProviderIdentity|undefined {
        let providerIdentity;
        channelMap.forEach(channel => {
            if (channel.channelName === channelName) {
                providerIdentity = channel;
            }
        });
        return providerIdentity;
    }

    export function createChannel(identity: Identity, channelName?: string): ProviderIdentity {
        const { uuid, name } = identity;
        const providerApp = getExternalOrOfWindowIdentity(identity);

        const channelId = getChannelId(uuid, name, channelName);

        // If a channel is already registered from that uuid, nack
        if (!providerApp || getChannelByChannelId(channelId)) {
            const nackString = 'Register Failed: Please note that only one channel may be registered per identity per channelName.';
            throw new Error(nackString);
        }

        const providerIdentity = { ...providerApp, channelName, channelId };
        const isExternal = providerIdentity;
        channelMap.set(channelId, providerIdentity);

        createChannelTeardown(providerIdentity);
        // Used internally by adapters for pending connections and onChannelConnect
        ofEvents.emit(route.channel('channel-connected'), providerIdentity);

        return providerIdentity;
    }

    export function connectToChannel(identity: Identity, payload: any, messageId: number, ack: AckFunc, nack: NackFunc): ProviderIdentity {
        const { wait, uuid, name, channelName, payload: connectionPayload } = payload;
        let providerIdentity: ProviderIdentity;
        if (channelName) {
            providerIdentity = Channel.getChannelByChannelName(channelName);
        }
        // No channel found by channel name, use identity
        if (!providerIdentity && uuid) {
            const providerIdentityArray = Channel.getChannelByIdentity({uuid, name});
            if (providerIdentityArray.length > 1) {
                const nackId = name ? `${uuid}/${name}` : uuid;
                nack(`More than one channel found for provider with identity: ${nackId}, please include a channelName`);
            } else {
                [ providerIdentity ] = providerIdentityArray;
            }
        }

        if (providerIdentity) {
            const ackKey = getAckKey(messageId, identity);
            remoteAckMap.set(ackKey, { ack, nack });

            const ackToSender = createAckToSender(identity, messageId, providerIdentity);

            // Forward the API call to the channel provider.
            sendToIdentity(providerIdentity, {
                action: CHANNEL_CONNECT_ACTION,
                payload: {
                    ackToSender,
                    providerIdentity,
                    clientIdentity: identity,
                    payload: connectionPayload
                }
            });
        } else {
            // Do not change this, checking for this in adapter
            const interimNackMessage = 'internal-nack';
            nack(interimNackMessage);
        }
        return providerIdentity;
    }

    export function sendChannelMessage(identity: Identity, payload: any, messageId: number, ack: AckFunc, nack: NackFunc): void {
        const { uuid, name, payload: messagePayload, action: channelAction, providerIdentity } = payload;
        const ackKey = getAckKey(messageId, identity);
        const targetIdentity = { uuid, name };

        remoteAckMap.set(ackKey, { ack, nack });

        const ackToSender = createAckToSender(identity, messageId, providerIdentity);

        sendToIdentity(targetIdentity, {
            action: CHANNEL_APP_ACTION,
            payload: {
                ackToSender,
                providerIdentity,
                action: channelAction,
                senderIdentity: identity,
                payload: messagePayload
            }
        });
    }

    // This preprocessor will check if the API call is an 'ack' action from a channel and match it to the original request.
    export function sendChannelResult(identity: Identity, payload: any, ack: AckFunc, nack: NackFunc): void {
        const { reason, success, destinationToken, correlationId, payload: ackPayload } = payload;
        const ackKey = getAckKey(correlationId, destinationToken);
        const remoteAck = remoteAckMap.get(ackKey);

        if (remoteAck) {
            if (success) {
                remoteAck.ack({
                    success: true,
                    ...(ackPayload ? { data: ackPayload } : {})
                });
            } else {
                remoteAck.nack(new Error(reason || 'Channel provider error'));
            }
            remoteAckMap.delete(ackKey);
        } else {
            nack('Ack failed, initial channel message not found.');
        }
    }
}

