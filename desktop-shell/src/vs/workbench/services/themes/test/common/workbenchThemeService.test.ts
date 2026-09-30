/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { migrateThemeSettingsId, ThemeSettingDefaults, ThemeSettings } from '../../common/workbenchThemeService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ThemeConfiguration } from '../../common/themeConfiguration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IHostColorSchemeService } from '../../common/hostColorSchemeService.js';
import { Event } from '../../../../../base/common/event.js';

class TestHostColorSchemeService implements IHostColorSchemeService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeColorScheme = Event.None;
	dark = false;
	highContrast = false;
}

suite('WorkbenchThemeService', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('migrateThemeSettingsId', () => {

		// This product ships only the OctoCode themes, so the ids these tests feed in
		// no longer name anything installed. Landing them on the OctoCode theme of the
		// same kind is what keeps an upgraded settings.json themed at all.

		test('maps every retired built-in dark theme onto the OctoCode dark theme', () => {
			const retired = ['Dark 2026', 'Dark Modern', 'Default Dark Modern', 'Dark+', 'Default Dark+',
				'Visual Studio Dark', 'Experimental Dark', 'VS Code Dark', 'Abyss', 'Kimbie Dark',
				'Monokai', 'Monokai Dimmed', 'Solarized Dark', 'Tomorrow Night Blue', 'Red'];
			assert.deepStrictEqual(
				retired.map(migrateThemeSettingsId),
				retired.map(() => ThemeSettingDefaults.COLOR_THEME_DARK)
			);
		});

		test('maps every retired built-in light theme onto the OctoCode light theme', () => {
			const retired = ['Light 2026', 'Light Modern', 'Default Light Modern', 'Light+', 'Default Light+',
				'Visual Studio Light', 'Experimental Light', 'VS Code Light', 'Quiet Light', 'Solarized Light'];
			assert.deepStrictEqual(
				retired.map(migrateThemeSettingsId),
				retired.map(() => ThemeSettingDefaults.COLOR_THEME_LIGHT)
			);
		});

		test('keeps high contrast settings on a high contrast theme', () => {
			// window.autoDetectHighContrast routes through these two ids. Folding them
			// into the ordinary themes would silently drop a user out of high contrast.
			assert.deepStrictEqual(
				['Default High Contrast', 'Default High Contrast Light'].map(migrateThemeSettingsId),
				[ThemeSettingDefaults.COLOR_THEME_HC_DARK, ThemeSettingDefaults.COLOR_THEME_HC_LIGHT]
			);
		});

		test('leaves third-party and current ids alone', () => {
			// The loading interface for third-party themes is the whole reason this is a
			// lookup table rather than a blanket reset to the default.
			const untouched = ['Some Custom Theme', 'GitHub Dark', '',
				ThemeSettingDefaults.COLOR_THEME_DARK, ThemeSettingDefaults.COLOR_THEME_LIGHT];
			assert.deepStrictEqual(untouched.map(migrateThemeSettingsId), untouched);
		});	});

	test('restores only for preferred color scheme changes', async () => {
		const configurationService = new TestConfigurationService({
			[ThemeSettings.DETECT_COLOR_SCHEME]: false,
			[ThemeSettings.DETECT_HC]: true,
		});
		const hostColorSchemeService = new TestHostColorSchemeService();
		const themeConfiguration = new ThemeConfiguration(configurationService, hostColorSchemeService);

		const results: boolean[] = [];
		hostColorSchemeService.dark = true;
		results.push(themeConfiguration.isPreferredColorSchemeChange({ dark: false, highContrast: false }));
		hostColorSchemeService.highContrast = true;
		results.push(themeConfiguration.isPreferredColorSchemeChange({ dark: true, highContrast: false }));
		hostColorSchemeService.dark = false;
		results.push(themeConfiguration.isPreferredColorSchemeChange({ dark: true, highContrast: true }));
		hostColorSchemeService.highContrast = false;
		results.push(themeConfiguration.isPreferredColorSchemeChange({ dark: false, highContrast: true }));

		await configurationService.setUserConfiguration(ThemeSettings.DETECT_COLOR_SCHEME, true);
		hostColorSchemeService.dark = true;
		results.push(themeConfiguration.isPreferredColorSchemeChange({ dark: false, highContrast: false }));

		assert.deepStrictEqual(results, [false, true, true, true, true]);
	});
});
