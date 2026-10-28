/// <reference types="node" />
/**
 * Class for comparing equality in sessionId port pairs
 */
export declare class SessionPortKey {
    /**
     * Session ID of the client SSH session, or null if the session does not have an ID
     * (because it is not encrypted and not client-specific).
     */
    sessionId: Buffer | null;
    /**
     * Forwarded port number
     */
    port: number;
    constructor(sessionId: Buffer | null, port: number);
    equals(other: SessionPortKey): boolean | null;
    toString(): string;
}
//# sourceMappingURL=sessionPortKey.d.ts.map