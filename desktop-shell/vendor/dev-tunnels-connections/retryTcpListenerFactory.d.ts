/// <reference types="node" />
import { TcpListenerFactory } from '@microsoft/dev-tunnels-ssh-tcp/tcpListenerFactory';
import { Server } from 'net';
import { CancellationToken } from 'vscode-jsonrpc';
/**
 * Implementation of a TCP listener factory that retries forwarding with nearby ports and falls back to a random port.
 * We make the assumption that the remote port that is being connected to and localPort numbers are the same.
 */
export declare class RetryTcpListenerFactory implements TcpListenerFactory {
    readonly localAddress: string;
    constructor(localAddress: string);
    createTcpListener(remotePort: number | undefined, localIPAddress: string, localPort: number, canChangeLocalPort: boolean, cancellation?: CancellationToken): Promise<Server>;
}
//# sourceMappingURL=retryTcpListenerFactory.d.ts.map