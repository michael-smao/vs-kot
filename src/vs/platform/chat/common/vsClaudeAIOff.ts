/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-claude: this fork has no AI. The chat code is still compiled in, because deleting it would make every
// upstream update harder. What it registers therefore has to be kept out of the two places that list
// everything there is: the Settings editor and the command palette.

/** A part of a setting's name that marks it as an AI setting, like `chat.`, `.mcp.` or `.chatResponseReceived`. */
const AI_SETTING_SEGMENT = /(?:^|\.)(?:chat|inlineChat|mcp|agents?|copilot|languageModels?|dictation|voice)(?=[A-Z.]|$)/;
/** The same words inside a camel-cased name, like `enableChatTools`. */
const AI_SETTING_WORD = /Chat|Copilot|Mcp|LanguageModel|Agent/;

/**
 * Whether a setting belongs to the AI features that this fork has switched off.
 */
export function isAISettingKey(key: string): boolean {
	if (AI_SETTING_SEGMENT.test(key)) {
		return true;
	}
	return AI_SETTING_WORD.test(key) && !/userAgent/i.test(key);
}

const AI_COMMAND_ID = /^(?:agentsVoice\.|inlineChat\.|github\.copilot\.|workbench\.action\.(?:chat|inlineChat|quickchat|openChat)|workbench\.mcp\.|mcp\.)/;

/**
 * Whether a command belongs to the AI features that this fork has switched off.
 */
export function isAICommandId(id: string): boolean {
	return AI_COMMAND_ID.test(id);
}
