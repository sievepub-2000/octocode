import { CancellationToken } from '@microsoft/dev-tunnels-ssh';
import { Emitter } from 'vscode-jsonrpc';
export declare class List {
    static groupBy<T, K>(list: {
        forEach(f: (item: T) => void): void;
    }, keyGetter: (item: T) => K): Map<K, T[]>;
}
/**
 * Resolves the promise after {@link milliseconds} have passed, or reject if {@link cancellation} is canceled.
 */
export declare function delay(milliseconds: number, cancellation?: CancellationToken): Promise<void>;
/**
 * Gets the error message.
 */
export declare function getErrorMessage(e: any): string;
/**
 * Wraps e in Error object if e is not Error. If e is Error, returns e as is.
 */
export declare function getError(e: any, messagePrefix?: string): Error;
/**
 * Races a promise and cancellation.
 */
export declare function withCancellation<T>(promise: Promise<T>, cancellation?: CancellationToken): Promise<T>;
/**
 * Tracking event emitter.
 */
export declare class TrackingEmitter<T> extends Emitter<T> {
    private subscribed;
    constructor();
    /**
     * A value indicating whether there event handlers subscribed to the event emitter.
     */
    get isSubscribed(): boolean;
}
//# sourceMappingURL=utils.d.ts.map