/// <reference types="node" />
import { Tunnel, TunnelReportProgressEventArgs } from '@microsoft/dev-tunnels-contracts';
import { TunnelManagementClient } from '@microsoft/dev-tunnels-management';
import { SshDisconnectReason, SshSessionClosedEventArgs, Trace } from '@microsoft/dev-tunnels-ssh';
import { CancellationToken, Disposable, Event } from 'vscode-jsonrpc';
import { TunnelConnector } from './tunnelConnector';
import { TunnelSession } from './tunnelSession';
import { TunnelConnectionBase } from './tunnelConnectionBase';
import * as http from 'http';
import { TunnelConnectionOptions } from './tunnelConnectionOptions';
import { RefreshingTunnelEventArgs } from './refreshingTunnelEventArgs';
import { TunnelRelayStreamFactory } from './tunnelRelayStreamFactory';
/**
 * Tunnel connection session.
 */
export declare class TunnelConnectionSession extends TunnelConnectionBase implements TunnelSession {
    protected readonly connectionProtocols: string[];
    /**
     * Gets the management client used for the connection.
     */
    protected readonly managementClient?: TunnelManagementClient | undefined;
    protected connectionOptions?: TunnelConnectionOptions;
    private connectedTunnel;
    private connector?;
    private reconnectPromise?;
    private connectionProtocolValue?;
    private disconnectionReason?;
    private connectionStartTime;
    private readonly uniqueConnectionId;
    private readonly refreshingTunnelEmitter;
    private readonly reportProgressEmitter;
    /**
     * Event that is raised to report connection progress.
     *
     * See `Progress` for a description of the different progress events that can be reported.
     */
    readonly onReportProgress: Event<TunnelReportProgressEventArgs>;
    httpAgent?: http.Agent;
    /**
     * Gets or sets a factory for creating relay streams.
     */
    streamFactory: TunnelRelayStreamFactory;
    /**
     * Name of the protocol used to connect to the tunnel.
     */
    get connectionProtocol(): string | undefined;
    protected set connectionProtocol(value: string | undefined);
    /**
     * Gets an ID that is unique to this instance of `TunnelConnectionSession`,
     * useful for correlating connection events over time.
     */
    protected get connectionId(): string;
    /**
     * A value indicating if this is a client tunnel connection (as opposed to host connection).
     */
    protected get isClientConnection(): boolean;
    /**
     * tunnel connection role, either "client", or "host", depending on @link tunnelAccessScope.
     */
    protected get connectionRole(): string;
    /**
     * Tunnel access token.
     */
    protected accessToken?: string;
    protected sshSessionDisposables: Disposable[];
    constructor(tunnelAccessScope: string, connectionProtocols: string[], 
    /**
     * Gets the management client used for the connection.
     */
    managementClient?: TunnelManagementClient | undefined, trace?: Trace);
    /**
     * Gets the trace source.
     */
    trace: Trace;
    /**
     * Get the tunnel of this tunnel connection.
     */
    get tunnel(): Tunnel | null;
    private set tunnel(value);
    /**
     * An event which fires when tunnel connection refreshes tunnel.
     */
    readonly refreshingTunnel: Event<RefreshingTunnelEventArgs>;
    /**
     * Tunnel has been assigned to or changed.
     */
    protected tunnelChanged(): void;
    /**
     * Determines whether E2E encryption is requested when opening connections through the tunnel
     * (V2 protocol only).
     *
     * The default value is true, but applications may set this to false (for slightly faster
     * connections).
     *
     * Note when this is true, E2E encryption is not strictly required. The tunnel relay and
     * tunnel host can decide whether or not to enable E2E encryption for each connection,
     * depending on policies and capabilities. Applications can verify the status of E2EE by
     * handling the `forwardedPortConnecting` event and checking the related property on the
     * channel request or response message.
     */
    enableE2EEncryption: boolean;
    /**
     * Gets a value indicating that this connection has already created its connector
     * and so can be reconnected if needed.
     */
    protected get isReconnectable(): boolean;
    /**
     * Gets the disconnection reason.
     * {@link SshDisconnectReason.none } if not yet disconnected.
     * {@link SshDisconnectReason.connectionLost} if network connection was lost and reconnects are not enabled or unsuccesfull.
     * {@link SshDisconnectReason.byApplication} if connection was disposed.
     * {@link SshDisconnectReason.tooManyConnections} if host connection was disconnected because another host connected for the same tunnel.
     */
    get disconnectReason(): SshDisconnectReason | undefined;
    /**
     * Sets the disconnect reason that caused disconnection.
     */
    protected set disconnectReason(reason: SshDisconnectReason | undefined);
    /**
     * Disposes this tunnel session, closing the SSH session used for it.
     */
    dispose(): Promise<void>;
    /**
     * Get a value indicating whether this session can attempt refreshing tunnel.
     * Note: tunnel refresh may still fail if the tunnel doesn't exist in the service,
     * tunnel access has changed, or tunnel access token has expired.
     */
    protected get canRefreshTunnel(): boolean | TunnelManagementClient;
    /**
     * Fetch the tunnel from the service if {@link managementClient} and {@link tunnel} are set.
     */
    protected refreshTunnel(includePorts?: boolean, cancellation?: CancellationToken): Promise<boolean>;
    /**
     * Creates a tunnel connector
     */
    protected createTunnelConnector(): TunnelConnector;
    /**
     * Trace info message.
     */
    protected traceInfo(msg: string): void;
    /**
     * Trace verbose message.
     */
    protected traceVerbose(msg: string): void;
    /**
     * Trace warning message.
     */
    protected traceWarning(msg: string, err?: Error): void;
    /**
     * Trace error message.
     */
    protected traceError(msg: string, err?: Error): void;
    /**
     * SSH session closed event handler. Child classes may use it unsubscribe session events and maybe start reconnecting.
     */
    protected onSshSessionClosed(e: SshSessionClosedEventArgs): void;
    /**
     * Start reconnecting if the tunnel connection is not yet disposed.
     */
    protected maybeStartReconnecting(reason?: SshDisconnectReason, message?: string, error?: Error | null): void;
    /**
     * Get a user-readable reason for SSH session disconnection, or an empty string.
     */
    protected getDisconnectReason(reason?: SshDisconnectReason, message?: string, error?: Error | null): string;
    /**
     * Connect to the tunnel session by running the provided {@link action}.
     */
    connectSession(action: () => Promise<void>): Promise<void>;
    /**
     * Connect to the tunnel session with the tunnel connector.
     * @param tunnel Tunnel to use for the connection.
     *     Undefined if the connection information is already known and the tunnel is not needed.
     *     Tunnel object to get the connection information from that tunnel.
     */
    connectTunnelSession(tunnel?: Tunnel, options?: TunnelConnectionOptions, cancellation?: CancellationToken): Promise<void>;
    /**
     * Validate the {@link tunnel} and get data needed to connect to it, if the tunnel is provided;
     * otherwise, ensure that there is already sufficient data to connect to a tunnel.
     */
    onConnectingToTunnel(): Promise<void>;
    /**
     * Validates tunnel access token if it's present. Returns the token.
     * Note: uses client's system time for the validation.
     */
    validateAccessToken(): string | undefined;
    /**
     * Unsubscribe SSH session events in @link TunnelSshConnectionSession.sshSessionDisposables
     */
    protected unsubscribeSessionEvents(): void;
}
//# sourceMappingURL=tunnelConnectionSession.d.ts.map