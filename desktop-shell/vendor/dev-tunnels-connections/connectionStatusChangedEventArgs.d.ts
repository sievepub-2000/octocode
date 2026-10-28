import { ConnectionStatus } from './connectionStatus';
/**
 * Connection status changed event args.
 */
export declare class ConnectionStatusChangedEventArgs {
    /**
     * Gets the previous connection status.
     */
    readonly previousStatus: ConnectionStatus;
    /**
     * Gets the current connection status.
     */
    readonly status: ConnectionStatus;
    /**
     * Gets the error that caused disconnect if {@link status} is {@link ConnectionStatus.Disconnected}.
     */
    readonly disconnectError?: Error | undefined;
    /**
     * Creates a new instance of ConnectionStatusChangedEventArgs.
     */
    constructor(
    /**
     * Gets the previous connection status.
     */
    previousStatus: ConnectionStatus, 
    /**
     * Gets the current connection status.
     */
    status: ConnectionStatus, 
    /**
     * Gets the error that caused disconnect if {@link status} is {@link ConnectionStatus.Disconnected}.
     */
    disconnectError?: Error | undefined);
}
//# sourceMappingURL=connectionStatusChangedEventArgs.d.ts.map