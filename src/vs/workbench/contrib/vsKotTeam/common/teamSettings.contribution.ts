/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the team's settings live in product.json.
// - `vsKotManagedSettings` are locked. They are applied in the policy layer of the configuration,
//   see platform/configuration/common/configurations.ts.
// - `vsKotDefaultSettings` are defaults that anyone may still change, for example per language.
//   They are registered here.

import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import product from '../../../../platform/product/common/product.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

const defaultSettings = product.vsKotDefaultSettings;
if (defaultSettings && Object.keys(defaultSettings).length > 0) {
	Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerDefaultConfigurations([{ overrides: defaultSettings }]);
}
