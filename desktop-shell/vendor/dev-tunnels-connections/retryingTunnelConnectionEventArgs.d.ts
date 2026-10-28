/**
 * Event args for tunnel connection retry event.
 */
export declare class RetryingTunnelConnectionEventArgs {
    /**
     * Gets the error that caused the retry.
     */
    readonly error: Error;
    /**
     * Gets the amount of time to wait before retrying. An event handler may change this value.
     */
    delayMs: number;
    constructor(
    /**
     * Gets the error that caused the retry.
     */
    error: Error, 
    /**
     * Gets the amount of time to wait before retrying. An event handler may change this value.
     */
    delayMs: number);
    /**
     * Gets or sets a value indicating whether the retry will proceed. An event handler may
     * set this to false to stop retrying.
     */
    retry: boolean;
}
//# sourceMappingURL=retryingTunnelConnectionEventArgs.d.ts.map