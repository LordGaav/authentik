import { t } from "@lingui/macro";

import { EVENT_WS_MESSAGE } from "../constants";
import { MessageLevel } from "../elements/messages/Message";
import { showMessage } from "../elements/messages/MessageContainer";

export interface WSMessage {
    message_type: string;
}

export class WebsocketClient {
    messageSocket?: WebSocket;
    retryDelay = 200;

    constructor() {
        try {
            this.connect();
        } catch (error) {
            console.warn(`authentik/ws: failed to connect to ws ${error}`);
        }
    }

    connect(): void {
        if (navigator.webdriver) return;
        const wsUrl = `${window.location.protocol.replace("http", "ws")}//${
            window.location.host
        }/ws/client/`;
        this.messageSocket = new WebSocket(wsUrl);
        this.messageSocket.addEventListener("open", () => {
            console.debug(`authentik/ws: connected to ${wsUrl}`);
            this.retryDelay = 200;
        });
        this.messageSocket.addEventListener("close", (e) => {
            console.debug(`authentik/ws: closed ws connection: ${e}`);
            if (this.retryDelay > 3000) {
                showMessage({
                    level: MessageLevel.error,
                    message: t`Connection error, reconnecting...`,
                });
            }
            setTimeout(() => {
                console.debug(`authentik/ws: reconnecting ws in ${this.retryDelay}ms`);
                this.connect();
            }, this.retryDelay);
            this.retryDelay = this.retryDelay * 2;
        });
        this.messageSocket.addEventListener("message", (e) => {
            const data = JSON.parse(e.data);
            window.dispatchEvent(
                new CustomEvent(EVENT_WS_MESSAGE, {
                    bubbles: true,
                    composed: true,
                    detail: data as WSMessage,
                }),
            );
        });
        this.messageSocket.addEventListener("error", () => {
            this.retryDelay = this.retryDelay * 2;
        });
    }
}
