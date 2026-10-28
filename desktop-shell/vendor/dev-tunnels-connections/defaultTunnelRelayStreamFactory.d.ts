import { Stream } from '@microsoft/dev-tunnels-ssh';
import { TunnelRelayStreamFactory } from './tunnelRelayStreamFactory';
import { IClientConfig } from 'websocket';
/**
 * Default factory for creating streams to a tunnel relay.
 */
export declare class DefaultTunnelRelayStreamFactory implements TunnelRelayStreamFactory {
    createRelayStream(relayUri: string, protocols: string[], accessToken?: string, clientConfig?: IClientConfig, additionalHeaders?: {
        [header: string]: string;
    }): Promise<{
        stream: Stream;
        protocol: string;
    }>;
}
//# sourceMappingURL=defaultTunnelRelayStreamFactory.d.ts.map