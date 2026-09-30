/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { verify as verifySignature } from 'crypto';
import { readFile } from 'fs/promises';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { getErrorMessage } from '../../../base/common/errors.js';
import { isDefined } from '../../../base/common/types.js';
import { buffer } from '../../../base/node/zip.js';
import { TargetPlatform } from '../../extensions/common/extensions.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { asJson, asText, IRequestService } from '../../request/common/request.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { ExtensionSignatureVerificationCode } from '../common/extensionManagement.js';

export const IExtensionSignatureVerificationService = createDecorator<IExtensionSignatureVerificationService>('IExtensionSignatureVerificationService');

export interface IExtensionSignatureVerificationResult {
	readonly code: ExtensionSignatureVerificationCode;
}

/**
 * A service for verifying signed extensions.
 */
export interface IExtensionSignatureVerificationService {
	readonly _serviceBrand: undefined;

	/**
	 * Verifies an extension file (.vsix) against a signature archive file.
	 * @param extensionId The extension identifier.
	 * @param version The extension version.
	 * @param vsixFilePath The extension file path.
	 * @param signatureArchiveFilePath The signature archive file path.
	 * @returns returns the verification result or undefined if the verification was not executed.
	 */
	verify(extensionId: string, version: string, vsixFilePath: string, signatureArchiveFilePath: string, clientTargetPlatform?: TargetPlatform): Promise<IExtensionSignatureVerificationResult | undefined>;
}

/**
 * Extension signature verification result
 */
export interface ExtensionSignatureVerificationResult {
	readonly code: ExtensionSignatureVerificationCode;
	readonly didExecute: boolean;
	readonly internalCode?: number;
	readonly output?: string;
}

export class ExtensionSignatureVerificationService implements IExtensionSignatureVerificationService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IProductService private readonly productService: IProductService,
		@IRequestService private readonly requestService: IRequestService,
	) { }

	public async verify(extensionId: string, version: string, vsixFilePath: string, signatureArchiveFilePath: string, clientTargetPlatform?: TargetPlatform): Promise<IExtensionSignatureVerificationResult | undefined> {
		const startTime = new Date().getTime();
		let result: ExtensionSignatureVerificationResult;

		try {
			this.logService.trace(`Verifying extension signature for ${extensionId}...`);
			await this.verifyOpenVsxSignature(extensionId, version, vsixFilePath, signatureArchiveFilePath);
			result = { code: ExtensionSignatureVerificationCode.Success, didExecute: true };
		} catch (e) {
			const error = e as Partial<ExtensionSignatureVerificationResult>;
			result = {
				code: error.code ?? ExtensionSignatureVerificationCode.UnknownError,
				didExecute: error.didExecute ?? false,
				output: error.output ?? getErrorMessage(e),
			};
		}

		const duration = new Date().getTime() - startTime;

		this.logService.info(`Extension signature verification result for ${extensionId}: ${result.code}. ${isDefined(result.internalCode) ? `Internal Code: ${result.internalCode}. ` : ''}Executed: ${result.didExecute}. Duration: ${duration}ms.`);
		this.logService.trace(`Extension signature verification output for ${extensionId}:\n${result.output}`);

		type ExtensionSignatureVerificationClassification = {
			owner: 'sandy081';
			comment: 'Extension signature verification event';
			extensionId: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'extension identifier' };
			extensionVersion: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'extension version' };
			code: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'result code of the verification' };
			internalCode?: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; 'isMeasurement': true; comment: 'internal code of the verification' };
			duration: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; 'isMeasurement': true; comment: 'amount of time taken to verify the signature' };
			didExecute: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'whether the verification was executed' };
			clientTargetPlatform?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'target platform of the client' };
		};
		type ExtensionSignatureVerificationEvent = {
			extensionId: string;
			extensionVersion: string;
			code: string;
			internalCode?: number;
			duration: number;
			didExecute: boolean;
			clientTargetPlatform?: string;
		};
		this.telemetryService.publicLog2<ExtensionSignatureVerificationEvent, ExtensionSignatureVerificationClassification>('extensionsignature:verification', {
			extensionId,
			extensionVersion: version,
			code: result.code,
			internalCode: result.internalCode,
			duration,
			didExecute: result.didExecute,
			clientTargetPlatform,
		});

		return { code: result.code };
	}

	private async verifyOpenVsxSignature(extensionId: string, version: string, vsixFilePath: string, signatureArchiveFilePath: string): Promise<void> {
		const separator = extensionId.indexOf('.');
		const serviceUrl = this.productService.extensionsGallery?.serviceUrl;
		if (separator < 1 || !serviceUrl) {
			throw new Error(`Cannot resolve the Open VSX signing key for ${extensionId}`);
		}

		const origin = new URL(serviceUrl).origin;
		const metadataUrl = `${origin}/api/${encodeURIComponent(extensionId.slice(0, separator))}/${encodeURIComponent(extensionId.slice(separator + 1))}/${encodeURIComponent(version)}`;
		const metadata = await asJson<{ files?: { publicKey?: string } }>(await this.requestService.request({ type: 'GET', url: metadataUrl, callSite: 'extensionSignatureVerification.metadata' }, CancellationToken.None));
		const publicKeyUrl = metadata?.files?.publicKey;
		if (!publicKeyUrl) {
			throw new Error(`Open VSX did not provide a signing key for ${extensionId}`);
		}

		const publicKey = await asText(await this.requestService.request({ type: 'GET', url: publicKeyUrl, callSite: 'extensionSignatureVerification.publicKey' }, CancellationToken.None));
		if (!publicKey) {
			throw new Error(`Open VSX returned an empty signing key for ${extensionId}`);
		}

		const [extension, signature] = await Promise.all([readFile(vsixFilePath), buffer(signatureArchiveFilePath, '.signature.sig')]);
		if (!verifySignature(null, extension, publicKey, signature)) {
			throw new Error(`The Open VSX signature is invalid for ${extensionId}`);
		}
	}
}
