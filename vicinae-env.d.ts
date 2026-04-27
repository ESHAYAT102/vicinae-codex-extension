/// <reference types="@vicinae/api">

/*
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 */

type ExtensionPreferences = {
  /** Model - Default Codex model for new requests. */
	"openaiModel"?: string;
}

declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Command: Chat */
	export type Codex = ExtensionPreferences & {
		
	}

	/** Command: Sessions */
	export type Sessions = ExtensionPreferences & {
		
	}

	/** Command: Models */
	export type Models = ExtensionPreferences & {
		
	}

	/** Command: Thinking */
	export type Thinking = ExtensionPreferences & {
		
	}
}

declare namespace Arguments {
  /** Command: Chat */
	export type Codex = {
		
	}

	/** Command: Sessions */
	export type Sessions = {
		
	}

	/** Command: Models */
	export type Models = {
		
	}

	/** Command: Thinking */
	export type Thinking = {
		
	}
}