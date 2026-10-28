"use strict";
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortRelayRequestMessage = void 0;
const dev_tunnels_ssh_tcp_1 = require("@microsoft/dev-tunnels-ssh-tcp");
/**
 * Extends port-forward request messagse to include additional properties required
 * by the tunnel relay.
 */
class PortRelayRequestMessage extends dev_tunnels_ssh_tcp_1.PortForwardRequestMessage {
    onWrite(writer) {
        super.onWrite(writer);
        if (!this.accessToken) {
            throw new Error("An access token is required.");
        }
        writer.writeString(this.accessToken, 'utf8');
    }
    onRead(reader) {
        super.onRead(reader);
        this.accessToken = reader.readString('utf8');
    }
}
exports.PortRelayRequestMessage = PortRelayRequestMessage;
//# sourceMappingURL=portRelayRequestMessage.js.map