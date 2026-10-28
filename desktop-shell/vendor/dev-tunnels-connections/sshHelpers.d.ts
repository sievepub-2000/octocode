/// <reference types="node" />
import * as ssh from '@microsoft/dev-tunnels-ssh';
import { IncomingMessage } from 'http';
import { connection as WebSocketConnection, IClientConfig } from 'websocket';
declare module 'websocket' {
    interface client {
        /**
         * 'httpResponse' event in WebSocketClient is fired when the server responds but the HTTP request doesn't properly upgrade to a web socket,
         * i.e. the status code is not 101 `Switching Protocols`. The argument of the event callback is the recieved response.
         */
        on(event: 'httpResponse', cb: (response: IncomingMessage) => void): this;
    }
}
/**
 * Error class for errors connecting to a web socket in non-node (browser) context.
 * There is no status code or underlying network error info in the browser context.
 */
export declare class BrowserWebSocketRelayError extends Error {
    constructor(message?: string);
}
/**
 * Ssh connection helper
 */
export declare class SshHelpers {
    /**
     * Open a connection to the relay uri depending on the running environment.
     * @param relayUri
     * @param protocols
     * @param headers
     * @param clientConfig
     * @returns
     */
    static openConnection(relayUri: string, protocols?: string[], headers?: object, clientConfig?: IClientConfig): Promise<ssh.WebSocketStream>;
    /**
     * Creates a client SSH session with standard configuration for tunnels.
     * @param configure Optional callback for additional session configuration.
     * @returns The created SSH session.
     */
    static createSshClientSession(configure?: (config: ssh.SshSessionConfiguration) => void): ssh.SshClientSession;
    /**
     * Creates a SSH server session with standard configuration for tunnels.
     * @param reconnectableSessions Optional list that tracks reconnectable sessions.
     * @param configure Optional callback for additional session configuration.
     * @returns The created SSH session.
     */
    static createSshServerSession(reconnectableSessions?: ssh.SshServerSession[], configure?: (config: ssh.SshSessionConfiguration) => void): ssh.SshServerSession;
    /**
     * Create a websocketStream from a connection.
     * @param connection
     * @returns
     */
    static createWebSocketStreamAdapter(connection: WebSocketConnection): ssh.WebSocketStream;
    /**
     * Set up a web Ssh stream factory.
     * @param socket
     * @returns
     */
    static webSshStreamFactory(socket: WebSocket): Promise<ssh.WebSocketStream>;
    private static createSshSession;
    private static nodeSshStreamFactory;
}
/**
 * Helper function to check the running environment.
 */
export declare const isNode: () => boolean;
/**
 * A workspace connection info
 */
export interface IWorkspaceConnectionInfo {
    id: string;
    relayLink?: string;
    relaySas?: string;
    hostPublicKeys: string[];
    isHostConnected?: boolean;
}
/**
 * The ssh session authenticate options
 */
export interface ISshSessionAuthenticateOptions {
    sessionToken: string;
    relaySas: string;
}
/**
 * The workspace session info required to join
 */
export type IWorkspaceSessionInfo = IWorkspaceConnectionInfo & ISshSessionAuthenticateOptions;
/**
 * A shared workspace info
 */
export interface ISharedWorkspaceInfo extends IWorkspaceConnectionInfo {
    name: string;
    joinLink: string;
    conversationId: string;
}
/**
 * Type of relay connection error types.
 */
export declare enum RelayErrorType {
    ConnectionError = 1,
    Unauthorized = 2,
    /**
     * @deprecated This relay error type is not used.
     */
    EndpointNotFound = 3,
    /**
     * @deprecated This relay error type is not used.
     */
    ListenerOffline = 4,
    ServerError = 5,
    TunnelPortNotFound = 6,
    TooManyRequests = 7,
    ServiceUnavailable = 8,
    BadGateway = 9
}
/**
 * Error used when a connection to the tunnel relay failed.
 */
export declare class RelayConnectionError extends Error {
    readonly errorContext: {
        errorType: RelayErrorType;
        statusCode?: number;
    };
    constructor(message: string, errorContext: {
        errorType: RelayErrorType;
        statusCode?: number;
    });
}
//# sourceMappingURL=sshHelpers.d.ts.map