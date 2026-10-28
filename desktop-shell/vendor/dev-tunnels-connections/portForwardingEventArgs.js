"use strict";
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortForwardingEventArgs = void 0;
/**
 * Event raised when a port is about to be forwarded to the tunnel client.
 */
class PortForwardingEventArgs {
    /**
     * Creates a new instance of PortForwardingEventArgs.
     */
    constructor(
    /**
     * Gets the port number that is being forwarded.
     */
    portNumber) {
        this.portNumber = portNumber;
        this.cancel = false;
    }
}
exports.PortForwardingEventArgs = PortForwardingEventArgs;
//# sourceMappingURL=portForwardingEventArgs.js.map