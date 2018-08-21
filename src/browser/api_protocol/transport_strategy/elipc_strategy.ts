/*
Copyright 2018 OpenFin Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import { AckMessage, AckFunc, AckPayload } from './ack';
import { ApiTransportBase, MessagePackage } from './api_transport_base';
import { default as RequestHandler } from './base_handler';
import { Endpoint, ActionMap } from '../shapes';
import { Identity } from '../../../shapes';
import * as log from '../../log';
import { getIdentityFromObject } from '../../../common/main';

declare var require: any;

const coreState = require('../../core_state');
const electronIpc = require('../../transports/electron_ipc');
const system = require('../../api/system').System;

// this represents the future default behavior, here its opt-in
const frameStrategy = coreState.argo.framestrategy;
const bypassLocalFrameConnect = frameStrategy === 'frames';


interface BufferedMessages {
    identity: Identity;
    frameRoutingId: number;
    key: string;
    messages: Array<string>;
}

export class ElipcStrategy extends ApiTransportBase<MessagePackage> {

    constructor(actionMap: ActionMap, requestHandler: RequestHandler<MessagePackage>) {
        super(actionMap, requestHandler);

        this.requestHandler.addHandler((mp: MessagePackage, next: () => void) => {
            const { identity, data, ack, nack, e, strategyName } = mp;

            if (strategyName !== this.constructor.name) {
                next();
            } else {
                const endpoint: Endpoint = this.actionMap[data.action];
                if (endpoint) {
                    // If --framestrategy=frames is set, short circuit the checks. This will
                    // allow calls from all frames through with iframes getting auto named
                    if (bypassLocalFrameConnect ||
                        !data.singleFrameOnly === false ||
                        e.sender.isValidWithFrameConnect(e.frameRoutingId)) {
                        Promise.resolve()
                            .then(() => endpoint.apiFunc(identity, data, ack, nack))
                            .then(result => {
                                // older action calls will invoke ack internally, newer ones will return a value
                                if (result !== undefined) {
                                    ack(new AckPayload(result));
                                }
                            }).catch(err => {
                                nack(err);
                            });
                    } else {
                        nack('API access has been superseded by another frame in this window.');
                    }
                }
            }
        });
    }

    public registerMessageHandlers(): void {
        electronIpc.ipc.on(electronIpc.channels.WINDOW_MESSAGE, this.onMessage.bind(this));
    }

    private canTrySend(routingInfo: any): boolean {
        const { browserWindow, frameRoutingId } = routingInfo;
        const browserWindowLocated = browserWindow;
        const browserWindowExists = !browserWindow.isDestroyed();
        const validRoutingId = typeof frameRoutingId === 'number';
        return browserWindowLocated && browserWindowExists && validRoutingId;
    }

    private innerSend(payload: string,
                      frameRoutingId: number,
                      mainFrameRoutingId: number,
                      browserWindow: any): void {
        // Dispatch the message
        if (frameRoutingId === mainFrameRoutingId) {
            // this is the main window frame
            if (coreState.argo.framestrategy === 'frames') {
                browserWindow.webContents.sendToFrame(frameRoutingId, electronIpc.channels.CORE_MESSAGE, payload);
            } else {
                browserWindow.send(electronIpc.channels.CORE_MESSAGE, payload);
            }
        } else {
            // frameRoutingId != browserWindow.webContents.mainFrameRoutingId implies a frame
            browserWindow.webContents.sendToFrame(frameRoutingId, electronIpc.channels.CORE_MESSAGE, payload);
        }
    }

    private delayedMessageHandler(bufferedMessages: BufferedMessages): void {
        const { uuid, name } = bufferedMessages.identity;
        const routingInfo = coreState.getRoutingInfoByUuidFrame(uuid, name);

        if (!routingInfo) {
            system.debugLog(1, `Routing info for uuid:${uuid} name:${name} not found`);
            return;
        }

        const { browserWindow, frameRoutingId, mainFrameRoutingId } = routingInfo;
        const canTrySend = this.canTrySend(routingInfo);

        if (!canTrySend) {
            const pred1 = `uuid:${uuid} name:${name} frameRoutingId:${frameRoutingId} not reachable, `;
            const pred2 = `payload:${JSON.stringify(bufferedMessages.messages)}`;
            system.debugLog(1, `${pred1}{$pred2}`);
        } else {
            const batchMessage = {
                action: 'process-api-batch',
                payload: {
                    messages: bufferedMessages.messages
                }
            };

            //bufferedMessages.messages.forEach((m: any) => {
            //    const payload = m;
                this.innerSend(JSON.stringify(batchMessage), frameRoutingId, mainFrameRoutingId, browserWindow);
            //});
        }
    }

    private bufferedMessageHandler = new class {

        private pendingMessages: any = {};
        private pendingFlush: boolean = false;
        private handler: (bufferedMessages: BufferedMessages) => void;

        constructor(handler: any) {
            this.handler = handler;
        }

        private flush(): void {
            Object.keys(this.pendingMessages).forEach((key: string) => {
                const bufferedMessages = this.pendingMessages[key];
                this.handler(bufferedMessages);
                bufferedMessages.messages = [];
            });

            this.pendingFlush = false;
        }

        public add(key: string, identity: any, frameRoutingId: number, payload: string): void {
            if (!this.pendingFlush) {
                setImmediate(() => { this.flush(); });
            }

            const entry = (this.pendingMessages[key] = this.pendingMessages[key] || {
                identity,
                frameRoutingId,
                key,
                messages: []
            });

            entry.messages.push(payload);
        }
    }(this.delayedMessageHandler.bind(this));

    public send(identity: Identity, payloadObj: any): void {
        const { uuid, name } = identity;
        const routingInfo = coreState.getRoutingInfoByUuidFrame(uuid, name);

        if (!routingInfo) {
            system.debugLog(1, `Routing info for uuid:${uuid} name:${name} not found`);
            return;
        }

        const { browserWindow, mainFrameRoutingId, frameRoutingId } = routingInfo;
        const payload = JSON.stringify(payloadObj);

        // Example: Fallback to direct message if not buffering for this window
        const buffer = true;
        if (!buffer) {
            if (!this.canTrySend(routingInfo)) {
                const pred1 = `uuid:${uuid} name:${name} frameRoutingId:${frameRoutingId} not reachable, payload:${payload}`;
                system.debugLog(1, `uuid:${uuid} name:${name} frameRoutingId:${frameRoutingId} not reachable, payload:${payload}`);
            } else {
                this.innerSend(payload, frameRoutingId, mainFrameRoutingId, browserWindow);
            }
        } else {
            // Queue it up
            const bufferKey = `${(!browserWindow.isDestroyed() ? browserWindow.id : -1)} - ${frameRoutingId}`;
            this.bufferedMessageHandler.add(bufferKey,
                                            identity,
                                            frameRoutingId,
                                            payload);
        }
    }

    //TODO: this needs to be refactor at some point.
    public onClientAuthenticated(cb: Function): void {
        throw new Error('Not implemented');
    }

    //TODO: this needs to be refactor at some point.
    public onClientDisconnect(cb: Function): void {
        throw new Error('Not implemented');
    }

    protected onMessage(e: any, rawData: any, ackDelegate: any): void {

        try {
            const data = JSON.parse(JSON.stringify(rawData));
            const ack = !data.isSync ? (ackDelegate ? ackDelegate(e, data.messageId, data) : this.ackDecorator(e, data.messageId, data))
                            : this.ackDecoratorSync(e, data.messageId);
            const nack = this.nackDecorator(ack);
            const browserWindow = e.sender.getOwnerBrowserWindow();
            const currWindow = browserWindow ? coreState.getWinById(browserWindow.id) : null;
            const openfinWindow = currWindow && currWindow.openfinWindow;
            const opts = openfinWindow && openfinWindow._options || {};
            const subFrameName = bypassLocalFrameConnect ? e.sender.getFrameName(e.frameRoutingId) : null;
            const identity = {
                name: subFrameName || opts.name,
                uuid: opts.uuid,
                parentFrame: opts.name,
                entityType: e.sender.getEntityType(e.frameRoutingId),
                transaction: data.action === 'api-transaction'
            };

            /* tslint:disable: max-line-length */
            //message payload might contain sensitive data, mask it.
            const disableIabSecureLogging = coreState.getAppObjByUuid(opts.uuid)._options.disableIabSecureLogging;
            const replacer = (!disableIabSecureLogging && (data.action === 'publish-message' || data.action === 'send-message')) ? this.payloadReplacer : null;
            system.debugLog(1, `received in-runtime${data.isSync ? '-sync ' : ''}: ${e.frameRoutingId} [${identity.uuid}]-[${identity.name}] ${JSON.stringify(data, replacer)}`);
            /* tslint:enable: max-line-length */

            if (!identity.transaction) {
                this.requestHandler.handle({
                    identity, data, ack, nack, e,
                    strategyName: this.constructor.name
                });
            } else {
                const deferredAck = this.ackDecoratorDeferred(e,
                                                              data.messageId,
                                                              data.payload.messages.length,
                                                              data);
                data.payload.messages.forEach((m: any) => {
                    this.onMessage(e, m, deferredAck);
                });
            }

        } catch (err) {
            system.debugLog(1, err);
        }
    }

    protected ackDecoratorSync(e: any, messageId: number): AckFunc {
        const ackObj = new AckMessage();
        ackObj.correlationId = messageId;

        return (payload: any): void => {
            ackObj.payload = payload;

            try {
                // Log all messages when -v=1
                system.debugLog(1, `sent sync in-runtime <= ${JSON.stringify(ackObj)}`);
            } catch (err) {
                /* tslint:disable: no-empty */
            }

            if (!e.sender.isDestroyed()) {
                e.returnValue = JSON.stringify(ackObj);
            }
        };
    }

    protected ackDecoratorDeferred(e: any, messageId: number, totalAcksExpected: number, originalPayload: any): any {
       const deferredAcks: any = [];
       const mainAck = this.ackDecorator(e, messageId, originalPayload);

        originalPayload.breadcrumbs = originalPayload.breadcrumbs || [];

        originalPayload.breadcrumbs.push({
            action: originalPayload.action,
            messageId: messageId,
            name: 'core/ackDecoratorDeferred',
            time: Date.now()
        });

       return (e: any, messageId: number, originalPayload: any): AckFunc => {
           const ackObj = new AckMessage();
           ackObj.correlationId = messageId;
           ackObj.originalAction = originalPayload.action;

            ackObj.breadcrumbs = originalPayload.breadcrumbs || [];

            ackObj.breadcrumbs.push({
                action: originalPayload.action,
                messageId: messageId,
                name: 'core/ackDelegate',
                time: Date.now()
            });

           return (payload: any): void => {
               ackObj.payload = payload;


               ackObj.breadcrumbs.push({
                    action: originalPayload.action,
                    messageId: messageId,
                    name: 'core/deferredACK',
                    time: Date.now()
                });

               deferredAcks.push(ackObj);
               //deferredAcks.push(JSON.stringify(ackObj));

               //system.debugLog(1, 'deferred ack');

               if (deferredAcks.length === totalAcksExpected) {
                   mainAck({
                    success: true,
                    data: deferredAcks
                   });
               }
           };
       };
    }

    protected ackDecorator(e: any, messageId: number, originalPayload: any): AckFunc {
        const ackObj = new AckMessage();
        ackObj.correlationId = messageId;
        ackObj.originalAction = originalPayload.action;
        ackObj.breadcrumbs = originalPayload.breadcrumbs || [];

        ackObj.breadcrumbs.push({
            action: originalPayload.action,
            messageId: messageId,
            name: 'core/ackDecorator',
            time: Date.now()
        });

        return (payload: any): void => {
            ackObj.payload = payload;

            try {
                // Log all messages when -v=1
                /* tslint:disable: max-line-length */
                system.debugLog(1, `sent in-runtime <= ${e.frameRoutingId} ${JSON.stringify(ackObj)}`);
            } catch (err) {
                /* tslint:disable: no-empty */
            }

            if (!e.sender.isDestroyed()) {
                ackObj.breadcrumbs.push({
                    action: originalPayload.action,
                    messageId: messageId,
                    name: 'core/ACK',
                    time: Date.now()
                });

                // Example: Fallback to direct message if not buffering for this window
                const buffer = true;
                if (!buffer) {
                    e.sender.sendToFrame(e.frameRoutingId,
                                         electronIpc.channels.CORE_MESSAGE,
                                         JSON.stringify(ackObj));
                } else {
                    const browserWindow = e.sender.getOwnerBrowserWindow();
                    const frameRoutingId = e.frameRoutingId;
                    const bufferKey = `${(!browserWindow.isDestroyed() ? browserWindow.id : -1)} - ${frameRoutingId}`;
                    const ofWindow = coreState.getWinById(browserWindow.id);
                    const identity = getIdentityFromObject(ofWindow.openfinWindow);

                    this.bufferedMessageHandler.add(bufferKey,
                                identity,
                                frameRoutingId,
                                JSON.stringify(ackObj));
                }

                // ToDo track outbound statistics
                /*ackObj.breadcrumbs.push({
                    action: originalPayload.action,
                    messageId: messageId,
                    name: 'core/after-ACK',
                    time: Date.now()
                });*/
            }
        };
    }
}
