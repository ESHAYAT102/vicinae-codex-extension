import { environment, getPreferenceValues, LocalStorage } from "@vicinae/api";
import { execFile, spawn } from "node:child_process";
import {
	mkdir,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	delimiter,
	dirname,
	extname,
	join,
	resolve,
} from "node:path";

export type Preferences = {
	openaiModel?: string;
};

export type AttachmentSummary = {
	name: string;
	path: string;
	kind: "image" | "file" | "directory";
	sizeBytes: number;
};

export type SessionMessage = {
	id: string;
	role: "user" | "assistant";
	text: string;
	createdAt: string;
	attachments?: AttachmentSummary[];
};

export type Session = {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	model: string;
	workDirectory?: string;
	codexSessionId?: string;
	archivedAt?: string;
	isTemporary?: boolean;
	messages: SessionMessage[];
};

export type SessionsFile = {
	sessions: Session[];
};

export type ComposeFormValues = {
	title?: string;
	prompt: string;
	attachments?: string[];
	skills?: string[];
	workDirectory?: string;
};

export type ChatSettings = {
	defaultSkills: string[];
	systemPrompt: string;
	inactiveDeleteMinutes: number;
};

export type CodexModel = {
	slug: string;
	displayName: string;
	description?: string;
	visibility?: string;
	supportedInApi?: boolean;
	reasoningLevels: string[];
	contextWindow?: number;
};

export type CodexThinkingLevel = "low" | "medium" | "high" | "xhigh";

type CodexPreparedAttachments = {
	summaries: AttachmentSummary[];
	imagePaths: string[];
	additionalWritableDirs: string[];
	promptBlock: string;
};

type CodexRunResult = {
	lastMessage: string;
	codexSessionId?: string;
	model: string;
};

type CodexIndexEntry = {
	id: string;
	thread_name?: string;
	updated_at?: string;
};

type AmbientSessionMetaPayload = {
	id?: string;
	timestamp?: string;
	cwd?: string;
	model?: string;
	model_slug?: string;
};

type AmbientEventPayload = {
	type?: string;
	message?: string;
	phase?: string;
	images?: string[];
	local_images?: string[];
};

type AmbientResponseMessagePayload = {
	type?: string;
	role?: string;
	phase?: string;
	content?: Array<{
		type?: string;
		text?: string;
	}>;
};

type AmbientSessionRecord = {
	timestamp?: string;
	type?: string;
	payload?: unknown;
};

const STORAGE_FILE = join(environment.supportPath, "sessions.json");
const OUTPUT_DIR = join(environment.supportPath, "outputs");
const LOCAL_CODEX_BIN = join(process.env.HOME ?? "", ".local", "bin", "codex");
const NPM_NPX_CACHE_DIR = join(process.env.HOME ?? "", ".npm", "_npx");
const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_WORK_DIRECTORY = join(process.env.HOME ?? "", "code", "codex");
const CODEX_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_FILE_COUNT = 100;
const SELECTED_MODEL_KEY = "selected-codex-model";
const SELECTED_THINKING_KEY = "selected-codex-thinking";
const DEFAULT_SKILLS_KEY = "default-codex-skills";
const SYSTEM_PROMPT_KEY = "default-codex-system-prompt";
const INACTIVE_DELETE_MINUTES_KEY = "inactive-chat-delete-minutes";
const INACTIVE_DELETE_NEVER_VALUE = 0;
const INACTIVE_DELETE_MINUTE_OPTIONS = [0, 5, 10, 12, 20, 25, 30] as const;
const DEFAULT_INACTIVE_DELETE_MINUTES = 5;
const SKILL_ROOTS = [
	join(process.env.HOME ?? "", ".codex", "skills"),
	join(process.env.HOME ?? "", ".agents", "skills"),
];
export async function readSessions(): Promise<Session[]> {
	const [storedSessions, ambientSessions] = await Promise.all([
		readStoredSessions(),
		readAmbientCodexSessions(),
	]);
	const mergedSessions = mergeSessions(storedSessions, ambientSessions);
	return await pruneInactiveTemporarySessions(mergedSessions);
}

async function readStoredSessions(): Promise<Session[]> {
	try {
		const fileContents = await readFile(STORAGE_FILE, "utf8");
		const parsed = JSON.parse(fileContents) as SessionsFile;
		return Array.isArray(parsed.sessions) ? parsed.sessions : [];
	} catch (error) {
		const message = getErrorMessage(error);
		if (message.includes("ENOENT")) {
			return [];
		}
		throw error;
	}
}

export async function writeSessions(sessions: Session[]) {
	await mkdir(environment.supportPath, { recursive: true });
	await writeFile(STORAGE_FILE, JSON.stringify({ sessions }, null, 2), "utf8");
}

export function sortSessions(sessions: Session[]) {
	return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getSessionById(sessionId: string) {
	const sessions = await readSessions();
	return sessions.find((session) => session.id === sessionId);
}

export async function renameSession(sessionId: string, title: string) {
	const sessions = await readSessions();
	const nextSessions = sessions.map((session) =>
		session.id === sessionId
			? {
					...session,
					title: title.trim() || "Untitled session",
					updatedAt: new Date().toISOString(),
				}
			: session,
	);
	await writeSessions(nextSessions);
	return nextSessions.find((session) => session.id === sessionId);
}

export async function setSessionArchived(sessionId: string, archived: boolean) {
	const sessions = await readSessions();
	const now = new Date().toISOString();
	const nextSessions = sessions.map((session) =>
		session.id === sessionId
			? {
					...session,
					archivedAt: archived ? now : undefined,
					updatedAt: now,
				}
			: session,
	);
	await writeSessions(nextSessions);
	return nextSessions.find((session) => session.id === sessionId);
}

export async function deleteSessionPermanently(sessionId: string) {
	const sessions = await readSessions();
	const session = sessions.find((item) => item.id === sessionId);
	const nextSessions = sessions.filter((item) => item.id !== sessionId);
	await writeSessions(nextSessions);
	if (session?.codexSessionId) {
		await deleteAmbientCodexArtifacts(session.codexSessionId);
	}
}

export async function deleteTemporarySession(session?: Session) {
	if (!session?.isTemporary || !session.codexSessionId) {
		return;
	}

	await deleteAmbientCodexArtifacts(session.codexSessionId);
}

export async function submitPrompt(
	values: ComposeFormValues,
	targetSession?: string | Session,
	onProgress?: (message: string) => void | Promise<void>,
): Promise<Session> {
	const prompt = values.prompt.trim();
	if (!prompt) {
		throw new Error("Add prompt before sending.");
	}

	await reportProgress(onProgress, "Reading sessions");
	const sessions = await withTimeout(readSessions(), "Reading sessions", 30_000);
	const existingSession =
		typeof targetSession === "string"
			? sessions.find((session) => session.id === targetSession)
			: targetSession;
	const prefs = readPreferences();
	await reportProgress(onProgress, "Loading settings");
	const [selectedModel, selectedThinking, settings, availableModels] = await withTimeout(
		Promise.all([
			getSelectedModel(),
			getSelectedThinking(),
			getChatSettings(),
			getAvailableModels(),
		]),
		"Loading settings",
		30_000,
	);
	const model =
		selectedModel ||
		prefs.openaiModel?.trim() ||
		existingSession?.model ||
		availableModels[0]?.slug ||
		DEFAULT_MODEL;
	const title =
		values.title?.trim() ||
		existingSession?.title ||
		makeTitleFromPrompt(prompt);
	await reportProgress(onProgress, "Preparing work directory");
	const workDirectory = await withTimeout(
		validateWorkDirectory(
			values.workDirectory?.trim() ||
				existingSession?.workDirectory ||
				DEFAULT_WORK_DIRECTORY,
		),
		"Preparing work directory",
		30_000,
	);

	await reportProgress(onProgress, "Preparing attachments");
	const expandedPaths = await withTimeout(
		expandAttachmentPaths(values.attachments ?? []),
		"Preparing attachments",
		30_000,
	);
	const preparedAttachments = await withTimeout(
		prepareAttachments(expandedPaths),
		"Reading attachments",
		30_000,
	);
	await reportProgress(onProgress, "Loading skills");
	const selectedSkills = await withTimeout(
		normalizeSelectedSkills(values.skills ?? []),
		"Loading skills",
		30_000,
	);

	const userMessage: SessionMessage = {
		id: createId("msg"),
		role: "user",
		text: filterSystemPrompt(prompt, settings.systemPrompt, selectedSkills),
		createdAt: new Date().toISOString(),
		attachments: preparedAttachments.summaries,
	};

	await reportProgress(onProgress, "Launching Codex CLI");
	const runResult = await runCodexPrompt({
		existingSession,
		model,
		thinkingLevel: selectedThinking,
		userPrompt: prompt,
		selectedSkills,
		systemPrompt: settings.systemPrompt,
		attachments: preparedAttachments,
		workDirectory,
		onProgress,
	});

	const assistantMessage: SessionMessage = {
		id: createId("msg"),
		role: "assistant",
		text: runResult.lastMessage.trim() || "Codex returned no text.",
		createdAt: new Date().toISOString(),
	};

	const nextSession: Session = existingSession
		? {
				...existingSession,
				title,
				model: runResult.model,
				workDirectory,
				codexSessionId:
					runResult.codexSessionId ?? existingSession.codexSessionId,
				updatedAt: assistantMessage.createdAt,
				isTemporary: false,
				messages: [...existingSession.messages, userMessage, assistantMessage],
			}
		: {
				id: createId("session"),
				title,
				createdAt: userMessage.createdAt,
				updatedAt: assistantMessage.createdAt,
				model: runResult.model,
				workDirectory,
				codexSessionId: runResult.codexSessionId,
				isTemporary: true,
				messages: [userMessage, assistantMessage],
			};

	const nextSessions = existingSession
		? sessions.some((session) => session.id === existingSession.id)
			? sessions.map((session) =>
					session.id === existingSession.id ? nextSession : session,
				)
			: [nextSession, ...sessions]
		: [nextSession, ...sessions];
	await reportProgress(onProgress, "Saving session");
	await writeSessions(nextSessions);

	return nextSession;
}

export function renderTranscriptMarkdown(session: Session) {
	const transcript = session.messages
		.map((message) => {
			const attachmentBlock =
				message.attachments && message.attachments.length > 0
					? [
							"",
							"Attachments:",
							...message.attachments.map(
								(attachment) =>
									`- ${escapeMarkdown(attachment.name)} (${attachment.kind}${attachment.sizeBytes ? `, ${formatBytes(attachment.sizeBytes)}` : ""})`,
							),
						].join("\n")
					: "";

			if (message.role === "user") {
				const text = stripLeadingPromptDirectives(message.text).trim();
				if (!text) {
					return null;
				}
				return [
					...text.split("\n").map((line) => `> ${line}`),
					attachmentBlock,
				]
					.filter(Boolean)
					.join("\n");
			}

			return [escapeMarkdown(message.text) || "_No text_", attachmentBlock]
				.filter(Boolean)
				.join("\n");
		})
		.filter(Boolean)
		.join("\n\n---\n\n");

	return transcript || "_No messages yet._";
}

function filterSystemPrompt(
	prompt: string,
	systemPrompt: string,
	selectedSkills: string[],
): string {
	const normalizedSystemPrompt = systemPrompt.trim().toLowerCase();
	const normalizedSkills = new Set(
		selectedSkills.map((skill) => `$${skill.trim().toLowerCase()}`),
	);

	const lines = prompt.split("\n");
	let startIndex = 0;
	while (startIndex < lines.length) {
		const trimmed = lines[startIndex].trim();
		if (!trimmed) {
			startIndex += 1;
			continue;
		}

		const normalized = trimmed.toLowerCase();
		if (
			normalized === "system instructions:" ||
			normalized === normalizedSystemPrompt ||
			normalizedSkills.has(normalized)
		) {
			startIndex += 1;
			continue;
		}
		break;
	}

	return lines.slice(startIndex).join("\n").trim();
}

function stripLeadingPromptDirectives(text: string): string {
	const lines = text.split("\n");
	let startIndex = 0;

	while (startIndex < lines.length) {
		const trimmed = lines[startIndex].trim();
		if (!trimmed) {
			startIndex += 1;
			continue;
		}

		const normalized = trimmed.toLowerCase();
		const compact = normalized.replace(/[`*_]/g, "");
		const isSystemInstructionLine =
			compact === "system instructions:" ||
			compact.startsWith("system instructions:");
		const isSkillDirective = compact.startsWith("$");
		const isNpmBunDirective =
			compact.includes("npm") &&
			compact.includes("bun") &&
			(compact.startsWith("if the task") || compact.startsWith("if the tasks"));

		if (isSystemInstructionLine || isSkillDirective || isNpmBunDirective) {
			startIndex += 1;
			continue;
		}
		break;
	}

	return lines.slice(startIndex).join("\n");
}

export function formatDate(value: string) {
	return new Date(value).toLocaleString();
}

export function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export async function getAvailableModels(): Promise<CodexModel[]> {
	const models = await readModelsFromCodexCli();
	return models?.length ? models : (await readModelsFromCache()) ?? [];
}

async function readModelsFromCodexCli(): Promise<CodexModel[] | undefined> {
	try {
		const codexBinaryPath = await getCodexBinaryPath();
		const output = await new Promise<string>((resolve, reject) => {
			execFile(
				codexBinaryPath,
				["debug", "models"],
				{
					env: buildCodexEnvironment(),
					timeout: 15_000,
					maxBuffer: 10 * 1024 * 1024,
				},
				(error, stdout) => (error ? reject(error) : resolve(stdout)),
			);
		});

		const parsed = JSON.parse(output) as {
			models?: Array<{
				slug?: string;
				display_name?: string;
				description?: string;
				visibility?: string;
				supported_in_api?: boolean;
				context_window?: number;
				supported_reasoning_levels?: Array<{ effort?: string }>;
			}>;
		};

		return normalizeCodexModels(parsed.models ?? []);
	} catch {
		return undefined;
	}
}

async function readModelsFromCache(): Promise<CodexModel[] | undefined> {
	const modelsCachePath = join(getAmbientCodexHome(), "models_cache.json");
	try {
		const raw = await readFile(modelsCachePath, "utf8");
		const parsed = JSON.parse(raw) as {
			models?: Array<{
				slug?: string;
				display_name?: string;
				description?: string;
				visibility?: string;
				supported_in_api?: boolean;
				context_window?: number;
				supported_reasoning_levels?: Array<{ effort?: string }>;
			}>;
		};
		return normalizeCodexModels(parsed.models ?? []);
	} catch {
		return undefined;
	}
}

function normalizeCodexModels(
	models: Array<{
		slug?: string;
		display_name?: string;
		description?: string;
		visibility?: string;
		supported_in_api?: boolean;
		context_window?: number;
		supported_reasoning_levels?: Array<{ effort?: string }>;
	}>,
) {
	return models
		.filter((model) => typeof model.slug === "string")
		.map((model) => ({
			slug: model.slug as string,
			displayName: model.display_name || model.slug || "Unknown",
			description: model.description,
			visibility: model.visibility,
			supportedInApi: model.supported_in_api,
			contextWindow: model.context_window,
			reasoningLevels: (model.supported_reasoning_levels ?? [])
				.map((item) => item.effort)
				.filter((value): value is string => Boolean(value)),
		}))
		.filter((model) => model.visibility !== "hidden");
}

export async function getAvailableSkills(): Promise<string[]> {
	const skills = new Set<string>();

	for (const root of SKILL_ROOTS) {
		try {
			const entries = await readdir(root, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) {
					continue;
				}
				const skillFile = join(root, entry.name, "SKILL.md");
				try {
					await stat(skillFile);
					skills.add(entry.name);
				} catch {
					// Ignore non-skill dirs.
				}
			}
		} catch {
			// Ignore missing roots.
		}
	}

	return [...skills].sort((a, b) => a.localeCompare(b));
}

export async function getDefaultSkillSelections(): Promise<string[]> {
	const storedSkills = parseStoredStringArray(
		await LocalStorage.getItem<string>(DEFAULT_SKILLS_KEY),
	);
	const skills = await getAvailableSkills();
	const fallbackSkills = skills.includes("caveman") ? ["caveman"] : [];
	return (storedSkills ?? fallbackSkills).filter((skill) =>
		skills.includes(skill),
	);
}

export async function getDefaultSystemPrompt() {
	return (await LocalStorage.getItem<string>(SYSTEM_PROMPT_KEY)) ?? "";
}

export function getInactiveDeleteMinuteOptions() {
	return [...INACTIVE_DELETE_MINUTE_OPTIONS];
}

export async function getInactiveDeleteMinutes() {
	const storedMinutes = Number(
		await LocalStorage.getItem<string>(INACTIVE_DELETE_MINUTES_KEY),
	);
	if (
		INACTIVE_DELETE_MINUTE_OPTIONS.includes(
			storedMinutes as (typeof INACTIVE_DELETE_MINUTE_OPTIONS)[number],
		)
	) {
		return storedMinutes;
	}
	return DEFAULT_INACTIVE_DELETE_MINUTES;
}

export async function getChatSettings(): Promise<ChatSettings> {
	const [defaultSkills, systemPrompt, inactiveDeleteMinutes] =
		await Promise.all([
			getDefaultSkillSelections(),
			getDefaultSystemPrompt(),
			getInactiveDeleteMinutes(),
		]);
	return {
		defaultSkills,
		systemPrompt,
		inactiveDeleteMinutes,
	};
}

export async function saveChatSettings(settings: ChatSettings) {
	await Promise.all([
		LocalStorage.setItem(
			DEFAULT_SKILLS_KEY,
			JSON.stringify(settings.defaultSkills),
		),
		LocalStorage.setItem(SYSTEM_PROMPT_KEY, settings.systemPrompt.trim()),
		LocalStorage.setItem(
			INACTIVE_DELETE_MINUTES_KEY,
			String(settings.inactiveDeleteMinutes),
		),
	]);
}

export async function getSelectedModel() {
	return await LocalStorage.getItem<string>(SELECTED_MODEL_KEY);
}

export async function setSelectedModel(modelSlug: string) {
	await LocalStorage.setItem(SELECTED_MODEL_KEY, modelSlug);
}

export async function clearSelectedModel() {
	await LocalStorage.removeItem(SELECTED_MODEL_KEY);
}

export async function getSelectedThinking() {
	return await LocalStorage.getItem<CodexThinkingLevel>(SELECTED_THINKING_KEY);
}

export async function setSelectedThinking(thinking: CodexThinkingLevel) {
	await LocalStorage.setItem(SELECTED_THINKING_KEY, thinking);
}

export async function clearSelectedThinking() {
	await LocalStorage.removeItem(SELECTED_THINKING_KEY);
}

export function getThinkingOptions(): CodexThinkingLevel[] {
	return ["low", "medium", "high", "xhigh"];
}

export function getDefaultWorkDirectory() {
	return DEFAULT_WORK_DIRECTORY;
}

export function formatWorkDirectoryForDisplay(workDirectory?: string) {
	if (!workDirectory) {
		return "";
	}

	const homeDirectory = process.env.HOME ?? "";
	if (homeDirectory && workDirectory === homeDirectory) {
		return "~";
	}

	if (homeDirectory && workDirectory.startsWith(`${homeDirectory}/`)) {
		return `~/${workDirectory.slice(homeDirectory.length + 1)}`;
	}

	return workDirectory;
}

function readPreferences(): Preferences {
	return getPreferenceValues<Preferences>();
}

async function runCodexPrompt({
	existingSession,
	model,
	thinkingLevel,
	userPrompt,
	selectedSkills,
	systemPrompt,
	attachments,
	workDirectory,
	onProgress,
}: {
	existingSession?: Session;
	model: string;
	thinkingLevel?: CodexThinkingLevel;
	userPrompt: string;
	selectedSkills: string[];
	systemPrompt?: string;
	attachments: CodexPreparedAttachments;
	workDirectory?: string;
	onProgress?: (message: string) => void | Promise<void>;
}): Promise<CodexRunResult> {
	await mkdir(OUTPUT_DIR, { recursive: true });

	const beforeIndex = await readCodexSessionIndex(getAmbientCodexHome());
	const outputFile = join(OUTPUT_DIR, `${createId("codex-output")}.txt`);
	const prompt = buildCodexPrompt({
		systemPrompt,
		userPrompt,
		selectedSkills,
		attachmentPromptBlock: attachments.promptBlock,
	});

	const execArgs = [
		"exec",
		"--skip-git-repo-check",
		"--full-auto",
		"-s",
		"read-only",
		"-o",
		outputFile,
		"-m",
		model,
		...(thinkingLevel
			? ["-c", `model_reasoning_effort="${thinkingLevel}"`]
			: []),
		"-C",
		workDirectory || process.cwd(),
		...attachments.imagePaths.flatMap((imagePath) => ["-i", imagePath]),
		...attachments.additionalWritableDirs.flatMap((dirPath) => [
			"--add-dir",
			dirPath,
		]),
	];

	const args = existingSession?.codexSessionId
		? [...execArgs, "resume", existingSession.codexSessionId, prompt]
		: [...execArgs, prompt];

	await spawnCodex(args, onProgress);

	const lastMessage = await readFile(outputFile, "utf8").catch(() => "");
	const afterIndex = await readCodexSessionIndex(getAmbientCodexHome());
	const sessionId =
		existingSession?.codexSessionId ||
		findNewestCodexSessionId(beforeIndex, afterIndex) ||
		(await findMatchingCodexSessionId(beforeIndex, prompt));

	return {
		lastMessage,
		codexSessionId: sessionId,
		model,
	};
}

async function spawnCodex(
	args: string[],
	onProgress?: (message: string) => void | Promise<void>,
) {
	const codexBinaryPath = await getCodexBinaryPath();
	await reportProgress(onProgress, `Codex binary: ${codexBinaryPath}`);

	return new Promise<void>((resolve, reject) => {
		const child = spawn(codexBinaryPath, args, {
			detached: process.platform !== "win32",
			env: buildCodexEnvironment(),
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stderr = "";
		let stdout = "";
		let didTimeout = false;
		let isSettled = false;
		const timeout = setTimeout(() => {
			didTimeout = true;
			if (child.pid) {
				try {
					if (process.platform === "win32") {
						child.kill("SIGTERM");
					} else {
						process.kill(-child.pid, "SIGTERM");
					}
				} catch {
					child.kill("SIGTERM");
				}
			}
		}, CODEX_TIMEOUT_MS);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			if (isSettled) {
				return;
			}
			isSettled = true;
			clearTimeout(timeout);
			if ("code" in error && error.code === "ENOENT") {
				reject(
					new Error(
						[
							"Codex CLI is not installed or not available in PATH.",
							"Install it with: bun add -g @openai/codex",
							"Then run `codex` and sign in with your OpenAI account.",
							"Recommended: install Caveman skills from https://getcaveman.dev",
						].join("\n"),
					),
				);
				return;
			}
			reject(error);
		});
		child.on("close", (code) => {
			if (isSettled) {
				return;
			}
			isSettled = true;
			clearTimeout(timeout);
			if (didTimeout) {
				const detail = [stderr.trim(), stdout.trim()]
					.filter(Boolean)
					.join("\n")
					.trim();
				reject(
					new Error(
						[
							`Codex CLI did not finish within ${Math.round(CODEX_TIMEOUT_MS / 60000)} minutes.`,
							"Check that `codex exec` works from a terminal, or set CODEX_BIN to a non-interactive Codex binary.",
							detail,
						]
							.filter(Boolean)
							.join("\n"),
					),
				);
				return;
			}
			if (code === 0) {
				resolve();
				return;
			}

			const detail = [stderr.trim(), stdout.trim()]
				.filter(Boolean)
				.join("\n")
				.trim();
			reject(
				new Error(detail || `Codex CLI exited with status code ${code ?? -1}.`),
			);
		});
	});
}

async function getCodexBinaryPath() {
	const configuredBinary = process.env.CODEX_BIN?.trim();
	if (configuredBinary) {
		return configuredBinary;
	}

	const pathBinary = await findExecutableOnPath("codex");
	if (pathBinary) {
		return pathBinary;
	}

	try {
		await stat(LOCAL_CODEX_BIN);
		return LOCAL_CODEX_BIN;
	} catch {
		return (await findCachedNpxCodexBinary()) ?? "codex";
	}
}

async function findExecutableOnPath(binaryName: string) {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) {
			continue;
		}
		const candidate = join(directory, binaryName);
		try {
			const candidateStats = await stat(candidate);
			if (candidateStats.isFile()) {
				return candidate;
			}
		} catch {
			// Keep searching PATH.
		}
	}
	return undefined;
}

async function findCachedNpxCodexBinary() {
	try {
		const cacheEntries = await readdir(NPM_NPX_CACHE_DIR, {
			withFileTypes: true,
		});
		const candidateRoots = await Promise.all(
			cacheEntries
				.filter((entry) => entry.isDirectory())
				.map(async (entry) => {
					const root = join(NPM_NPX_CACHE_DIR, entry.name);
					const rootStats = await stat(root);
					return { root, mtimeMs: rootStats.mtimeMs };
				}),
		);

		for (const { root } of candidateRoots.sort(
			(left, right) => right.mtimeMs - left.mtimeMs,
		)) {
			for (const candidate of getCachedCodexCandidates(root)) {
				try {
					const candidateStats = await stat(candidate);
					if (candidateStats.isFile()) {
						return candidate;
					}
				} catch {
					// Try next candidate.
				}
			}
		}
	} catch {
		return undefined;
	}

	return undefined;
}

function getCachedCodexCandidates(cacheRoot: string) {
	const candidates = [
		join(cacheRoot, "node_modules", ".bin", "codex"),
		join(cacheRoot, "node_modules", "@openai", "codex", "bin", "codex.js"),
	];

	if (process.platform === "linux" && process.arch === "x64") {
		candidates.unshift(
			join(
				cacheRoot,
				"node_modules",
				"@openai",
				"codex-linux-x64",
				"vendor",
				"x86_64-unknown-linux-musl",
				"codex",
				"codex",
			),
		);
	}

	if (process.platform === "linux" && process.arch === "arm64") {
		candidates.unshift(
			join(
				cacheRoot,
				"node_modules",
				"@openai",
				"codex-linux-arm64",
				"vendor",
				"aarch64-unknown-linux-musl",
				"codex",
				"codex",
			),
		);
	}

	return candidates;
}

function buildCodexEnvironment() {
	const commonPaths = [
		join(process.env.HOME ?? "", ".local", "bin"),
		join(process.env.HOME ?? "", ".npm", "_npx"),
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
	];
	const pathEntries = [
		...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
		...commonPaths,
	];

	return {
		...process.env,
		CODEX_HOME: getAmbientCodexHome(),
		PATH: [...new Set(pathEntries)].join(delimiter),
	};
}

function getAmbientCodexHome() {
	return process.env.CODEX_HOME?.trim()
		? process.env.CODEX_HOME.trim()
		: join(process.env.HOME ?? "", ".codex");
}

async function readCodexSessionIndex(
	codexHome: string,
): Promise<CodexIndexEntry[]> {
	const indexPath = join(codexHome, "session_index.jsonl");
	try {
		const raw = await readFile(indexPath, "utf8");
		return raw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as CodexIndexEntry)
			.filter((entry) => typeof entry.id === "string");
	} catch {
		return [];
	}
}

async function readAmbientCodexSessions(): Promise<Session[]> {
	const codexHome = getAmbientCodexHome();
	const sessionsRoot = join(codexHome, "sessions");
	const [indexEntries, sessionFiles] = await Promise.all([
		readCodexSessionIndex(codexHome),
		findSessionLogFiles(sessionsRoot),
	]);
	const indexById = new Map(indexEntries.map((entry) => [entry.id, entry]));
	const sessions = await Promise.all(
		sessionFiles.map((sessionFile) =>
			parseAmbientSessionFile(sessionFile, indexById),
		),
	);
	const parsedSessions = sessions.filter((session): session is Session =>
		Boolean(session),
	);
	const parsedIds = new Set(
		parsedSessions
			.map((session) => session.codexSessionId)
			.filter((id): id is string => Boolean(id)),
	);

	for (const indexEntry of indexEntries) {
		if (parsedIds.has(indexEntry.id)) {
			continue;
		}
		parsedSessions.push({
			id: makeAmbientSessionId(indexEntry.id),
			title: indexEntry.thread_name?.trim() || "Untitled session",
			createdAt: indexEntry.updated_at || new Date(0).toISOString(),
			updatedAt: indexEntry.updated_at || new Date(0).toISOString(),
			model: DEFAULT_MODEL,
			codexSessionId: indexEntry.id,
			messages: [],
		});
	}

	return parsedSessions;
}

async function parseAmbientSessionFile(
	filePath: string,
	indexById: Map<string, CodexIndexEntry>,
): Promise<Session | undefined> {
	try {
		const raw = await readFile(filePath, "utf8");
		const records = raw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as AmbientSessionRecord);
		const metaRecord = records.find((record) => record.type === "session_meta");
		const metaPayload = metaRecord?.payload as
			| AmbientSessionMetaPayload
			| undefined;
		const codexSessionId = metaPayload?.id?.trim();
		if (!codexSessionId) {
			return undefined;
		}

		const messages = parseAmbientMessages(records);
		const indexEntry = indexById.get(codexSessionId);
		const createdAt =
			metaPayload?.timestamp ||
			metaRecord?.timestamp ||
			messages[0]?.createdAt ||
			indexEntry?.updated_at ||
			new Date(0).toISOString();
		const updatedAt =
			indexEntry?.updated_at ||
			findLatestRecordTimestamp(records) ||
			messages[messages.length - 1]?.createdAt ||
			createdAt;

		return {
			id: makeAmbientSessionId(codexSessionId),
			title:
				indexEntry?.thread_name?.trim() ||
				makeTitleFromPrompt(
					messages.find((message) => message.role === "user")?.text || "",
				) ||
				"Untitled session",
			createdAt,
			updatedAt,
			model:
				metaPayload?.model?.trim() ||
				metaPayload?.model_slug?.trim() ||
				DEFAULT_MODEL,
			workDirectory: metaPayload?.cwd?.trim(),
			codexSessionId,
			messages,
		};
	} catch {
		return undefined;
	}
}

function parseAmbientMessages(
	records: AmbientSessionRecord[],
): SessionMessage[] {
	const messages: SessionMessage[] = [];

	for (const record of records) {
		if (record.type === "event_msg") {
			const payload = record.payload as AmbientEventPayload | undefined;
			if (payload?.type === "user_message" && payload.message) {
				messages.push({
					id: createId("msg"),
					role: "user",
					text: payload.message,
					createdAt: record.timestamp || new Date().toISOString(),
					attachments: summarizeAmbientAttachments(payload),
				});
				continue;
			}
			if (
				payload?.type === "agent_message" &&
				payload.phase === "final_answer" &&
				payload.message
			) {
				messages.push({
					id: createId("msg"),
					role: "assistant",
					text: payload.message,
					createdAt: record.timestamp || new Date().toISOString(),
				});
			}
			continue;
		}

		if (record.type !== "response_item") {
			continue;
		}

		const payload = record.payload as AmbientResponseMessagePayload | undefined;
		if (payload?.type !== "message" || payload.role !== "assistant") {
			continue;
		}
		if (payload.phase !== "final_answer") {
			continue;
		}
		const text = extractResponseMessageText(payload);
		if (!text) {
			continue;
		}
		const lastMessage = messages[messages.length - 1];
		if (lastMessage?.role === "assistant" && lastMessage.text === text) {
			continue;
		}
		messages.push({
			id: createId("msg"),
			role: "assistant",
			text,
			createdAt: record.timestamp || new Date().toISOString(),
		});
	}

	return messages;
}

function summarizeAmbientAttachments(
	payload: AmbientEventPayload,
): AttachmentSummary[] | undefined {
	const imageAttachments = [
		...(payload.images ?? []),
		...(payload.local_images ?? []),
	]
		.filter(Boolean)
		.map((imagePath) => ({
			name: basename(imagePath),
			path: imagePath,
			kind: "image" as const,
			sizeBytes: 0,
		}));
	return imageAttachments.length > 0 ? imageAttachments : undefined;
}

function extractResponseMessageText(payload: AmbientResponseMessagePayload) {
	return (payload.content ?? [])
		.filter((item) => item.type === "input_text" || item.type === "output_text")
		.map((item) => item.text?.trim())
		.filter((text): text is string => Boolean(text))
		.join("\n\n")
		.trim();
}

function findLatestRecordTimestamp(records: AmbientSessionRecord[]) {
	return [...records]
		.map((record) => record.timestamp?.trim())
		.filter((timestamp): timestamp is string => Boolean(timestamp))
		.sort((a, b) => b.localeCompare(a))[0];
}

function makeAmbientSessionId(codexSessionId: string) {
	return `ambient_${codexSessionId}`;
}

function mergeSessions(localSessions: Session[], ambientSessions: Session[]) {
	const ambientByCodexId = new Map(
		ambientSessions
			.filter((session) => Boolean(session.codexSessionId))
			.map((session) => [session.codexSessionId as string, session]),
	);
	const mergedSessions: Session[] = [];

	for (const localSession of localSessions) {
		if (!localSession.codexSessionId) {
			const matchedAmbientSession = findAmbientMatchForLocalSession(
				localSession,
				[...ambientByCodexId.values()],
			);
			if (!matchedAmbientSession?.codexSessionId) {
				mergedSessions.push(localSession);
				continue;
			}

			mergedSessions.push({
				...matchedAmbientSession,
				...localSession,
				id: localSession.id,
				title: localSession.title?.trim() || matchedAmbientSession.title,
				model: matchedAmbientSession.model || localSession.model,
				workDirectory:
					matchedAmbientSession.workDirectory || localSession.workDirectory,
				codexSessionId: matchedAmbientSession.codexSessionId,
				createdAt: chooseEarlierDate(
					localSession.createdAt,
					matchedAmbientSession.createdAt,
				),
				updatedAt: chooseLaterDate(
					localSession.updatedAt,
					matchedAmbientSession.updatedAt,
				),
				messages:
					matchedAmbientSession.messages.length > 0
						? matchedAmbientSession.messages
						: localSession.messages,
			});
			ambientByCodexId.delete(matchedAmbientSession.codexSessionId);
			continue;
		}

		const ambientSession = ambientByCodexId.get(localSession.codexSessionId);
		if (!ambientSession) {
			mergedSessions.push(localSession);
			continue;
		}

		mergedSessions.push({
			...ambientSession,
			...localSession,
			id: localSession.id,
			title: localSession.title?.trim() || ambientSession.title,
			model: ambientSession.model || localSession.model,
			workDirectory: ambientSession.workDirectory || localSession.workDirectory,
			codexSessionId:
				ambientSession.codexSessionId || localSession.codexSessionId,
			createdAt: chooseEarlierDate(
				localSession.createdAt,
				ambientSession.createdAt,
			),
			updatedAt: chooseLaterDate(
				localSession.updatedAt,
				ambientSession.updatedAt,
			),
			messages:
				ambientSession.messages.length > 0
					? ambientSession.messages
					: localSession.messages,
		});
		ambientByCodexId.delete(localSession.codexSessionId);
	}

	for (const ambientSession of ambientByCodexId.values()) {
		if (isPersistentAmbientSession(ambientSession)) {
			mergedSessions.push(ambientSession);
		}
	}

	return mergedSessions;
}

function isPersistentAmbientSession(session: Session) {
	return countUserMessages(session) > 1;
}

function countUserMessages(session: Session) {
	return session.messages.filter((message) => message.role === "user").length;
}

function findAmbientMatchForLocalSession(
	localSession: Session,
	ambientSessions: Session[],
) {
	const localUserMessage = localSession.messages.find(
		(message) => message.role === "user",
	)?.text;
	const localAssistantMessage = [...localSession.messages]
		.reverse()
		.find((message) => message.role === "assistant")?.text;

	if (!localUserMessage || !localAssistantMessage) {
		return undefined;
	}

	return ambientSessions
		.filter((ambientSession) => {
			const ambientUserMessage = ambientSession.messages.find(
				(message) => message.role === "user",
			)?.text;
			const ambientAssistantMessage = [...ambientSession.messages]
				.reverse()
				.find((message) => message.role === "assistant")?.text;

			if (!ambientUserMessage || !ambientAssistantMessage) {
				return false;
			}

			if (!ambientUserMessage.includes(localUserMessage.trim())) {
				return false;
			}

			if (ambientAssistantMessage.trim() !== localAssistantMessage.trim()) {
				return false;
			}

			return areDatesClose(localSession.createdAt, ambientSession.createdAt);
		})
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function areDatesClose(left: string, right: string, maxDiffMs = 5 * 60 * 1000) {
	const leftMs = new Date(left).getTime();
	const rightMs = new Date(right).getTime();
	if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) {
		return false;
	}
	return Math.abs(leftMs - rightMs) <= maxDiffMs;
}

function chooseEarlierDate(left: string, right: string) {
	return left.localeCompare(right) <= 0 ? left : right;
}

function chooseLaterDate(left: string, right: string) {
	return left.localeCompare(right) >= 0 ? left : right;
}

function findNewestCodexSessionId(
	before: CodexIndexEntry[],
	after: CodexIndexEntry[],
) {
	const previousIds = new Set(before.map((entry) => entry.id));
	const newest = [...after]
		.filter((entry) => !previousIds.has(entry.id))
		.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))[0];
	return newest?.id;
}

async function expandAttachmentPaths(inputPaths: string[]) {
	const uniquePaths = [...new Set(inputPaths.filter(Boolean))];
	const expandedFiles: string[] = [];
	let totalBytes = 0;

	for (const currentPath of uniquePaths) {
		const stats = await stat(currentPath);
		if (stats.isDirectory()) {
			const directoryFiles = await walkDirectory(currentPath);
			for (const filePath of directoryFiles) {
				const fileStats = await stat(filePath);
				totalBytes += fileStats.size;
				expandedFiles.push(filePath);
			}
		} else {
			totalBytes += stats.size;
			expandedFiles.push(currentPath);
		}
	}

	if (expandedFiles.length > MAX_FILE_COUNT) {
		throw new Error(
			`Too many files selected (${expandedFiles.length}). Keep under ${MAX_FILE_COUNT}.`,
		);
	}

	if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
		throw new Error(
			`Attachments too large (${formatBytes(totalBytes)}). Keep total under 50 MB.`,
		);
	}

	return uniquePaths;
}

async function walkDirectory(directoryPath: string): Promise<string[]> {
	const entries = await readdir(directoryPath, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const fullPath = join(directoryPath, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walkDirectory(fullPath)));
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}

	return files;
}

async function prepareAttachments(
	paths: string[],
): Promise<CodexPreparedAttachments> {
	const imagePaths: string[] = [];
	const additionalDirs = new Set<string>([process.cwd()]);
	const summaries: AttachmentSummary[] = [];
	const promptLines: string[] = [];

	for (const attachmentPath of paths) {
		const stats = await stat(attachmentPath);
		if (stats.isDirectory()) {
			additionalDirs.add(attachmentPath);
			const files = await walkDirectory(attachmentPath);
			summaries.push({
				name: basename(attachmentPath),
				path: attachmentPath,
				kind: "directory",
				sizeBytes: 0,
			});
			promptLines.push(
				`- directory: ${attachmentPath} (${files.length} files available)`,
			);
			continue;
		}

		const kind = isImagePath(attachmentPath) ? "image" : "file";
		summaries.push({
			name: basename(attachmentPath),
			path: attachmentPath,
			kind,
			sizeBytes: stats.size,
		});
		additionalDirs.add(dirname(attachmentPath));

		if (kind === "image") {
			imagePaths.push(attachmentPath);
			promptLines.push(`- image: ${attachmentPath}`);
		} else {
			promptLines.push(`- file: ${attachmentPath}`);
		}
	}

	return {
		summaries,
		imagePaths,
		additionalWritableDirs: [...additionalDirs],
		promptBlock:
			promptLines.length > 0 ? ["Attachments:", ...promptLines].join("\n") : "",
	};
}

function buildCodexPrompt({
	systemPrompt,
	userPrompt,
	selectedSkills,
	attachmentPromptBlock,
}: {
	systemPrompt?: string;
	userPrompt: string;
	selectedSkills: string[];
	attachmentPromptBlock: string;
}) {
	return [
		systemPrompt?.trim()
			? ["System instructions:", systemPrompt.trim()].join("\n")
			: "",
		...selectedSkills.map((skill) => `$${skill}`),
		userPrompt.trim(),
		attachmentPromptBlock.trim(),
	]
		.filter(Boolean)
		.join("\n\n");
}

async function findMatchingCodexSessionId(
	beforeIndex: CodexIndexEntry[],
	prompt: string,
) {
	const previousIds = new Set(beforeIndex.map((entry) => entry.id));
	const ambientSessions = await readAmbientCodexSessions();

	return ambientSessions
		.filter(
			(session) =>
				Boolean(session.codexSessionId) &&
				!previousIds.has(session.codexSessionId as string) &&
				session.messages.some(
					(message) =>
						message.role === "user" && message.text.trim() === prompt.trim(),
				),
		)
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
		?.codexSessionId;
}

async function normalizeSelectedSkills(skills: string[]) {
	if (skills.length > 0) {
		return skills;
	}

	return await getDefaultSkillSelections();
}

async function reportProgress(
	onProgress: ((message: string) => void | Promise<void>) | undefined,
	message: string,
) {
	await onProgress?.(message);
}

async function withTimeout<T>(
	promise: Promise<T>,
	label: string,
	timeoutMs: number,
) {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					reject(
						new Error(
							`${label} did not finish within ${Math.round(timeoutMs / 1000)} seconds.`,
						),
					);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

function parseStoredStringArray(raw: string | undefined) {
	if (!raw?.trim()) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === "string")
			: undefined;
	} catch {
		return undefined;
	}
}

async function pruneInactiveTemporarySessions(sessions: Session[]) {
	const inactiveDeleteMinutes = await getInactiveDeleteMinutes();
	if (inactiveDeleteMinutes === INACTIVE_DELETE_NEVER_VALUE) {
		return sessions;
	}
	const expiredSessions = sessions.filter((session) =>
		isTemporarySessionExpired(session, inactiveDeleteMinutes),
	);
	if (expiredSessions.length === 0) {
		return sessions;
	}

	const expiredIds = new Set(expiredSessions.map((session) => session.id));
	const nextSessions = sessions.filter(
		(session) => !expiredIds.has(session.id),
	);
	await writeSessions(
		nextSessions.filter((session) => !session.id.startsWith("ambient_")),
	);
	await Promise.all(
		expiredSessions.map((session) =>
			session.codexSessionId
				? deleteAmbientCodexArtifacts(session.codexSessionId)
				: Promise.resolve(),
		),
	);
	return nextSessions;
}

function isTemporarySessionExpired(
	session: Session,
	inactiveDeleteMinutes: number,
) {
	if (!session.isTemporary) {
		return false;
	}

	const updatedAtMs = new Date(session.updatedAt).getTime();
	if (Number.isNaN(updatedAtMs)) {
		return false;
	}

	return Date.now() - updatedAtMs >= inactiveDeleteMinutes * 60 * 1000;
}

async function validateWorkDirectory(workDirectory?: string) {
	if (!workDirectory) {
		return undefined;
	}

	const resolvedWorkDirectory = expandHomeDirectory(workDirectory);

	try {
		await mkdir(resolvedWorkDirectory, { recursive: true });
		const directoryStats = await stat(resolvedWorkDirectory);
		if (!directoryStats.isDirectory()) {
			throw new Error("Work directory path is not a directory.");
		}
		return resolvedWorkDirectory;
	} catch (error) {
		const message = getErrorMessage(error);
		if (message === "Work directory path is not a directory.") {
			throw error;
		}
		throw new Error(`Could not prepare work directory: ${message}`);
	}
}

function expandHomeDirectory(inputPath: string) {
	if (inputPath === "~") {
		return process.env.HOME ?? inputPath;
	}

	if (inputPath.startsWith("~/")) {
		return join(process.env.HOME ?? "", inputPath.slice(2));
	}

	return resolve(inputPath);
}

function isImagePath(filePath: string) {
	return [
		".png",
		".jpg",
		".jpeg",
		".webp",
		".gif",
		".bmp",
		".svg",
		".avif",
	].includes(extname(filePath).toLowerCase());
}

async function deleteAmbientCodexArtifacts(codexSessionId: string) {
	const codexHome = getAmbientCodexHome();
	await removeFromCodexSessionIndex(codexHome, codexSessionId);
	await removeCodexSessionFiles(codexHome, codexSessionId);
}

async function removeFromCodexSessionIndex(
	codexHome: string,
	codexSessionId: string,
) {
	const indexPath = join(codexHome, "session_index.jsonl");
	try {
		const raw = await readFile(indexPath, "utf8");
		const nextLines = raw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.filter((line) => {
				try {
					return (JSON.parse(line) as CodexIndexEntry).id !== codexSessionId;
				} catch {
					return true;
				}
			});
		const nextRaw = nextLines.length > 0 ? `${nextLines.join("\n")}\n` : "";
		await writeFile(indexPath, nextRaw, "utf8");
	} catch {
		// Ignore if Codex index unavailable.
	}
}

async function removeCodexSessionFiles(
	codexHome: string,
	codexSessionId: string,
) {
	const sessionsRoot = join(codexHome, "sessions");
	const matches = await findFilesContainingId(sessionsRoot, codexSessionId);
	await Promise.all(matches.map((filePath) => rm(filePath, { force: true })));
}

async function findFilesContainingId(
	root: string,
	needle: string,
): Promise<string[]> {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		const matches: string[] = [];

		for (const entry of entries) {
			const fullPath = join(root, entry.name);
			if (entry.isDirectory()) {
				matches.push(...(await findFilesContainingId(fullPath, needle)));
				continue;
			}
			if (entry.isFile() && entry.name.includes(needle)) {
				matches.push(fullPath);
			}
		}

		return matches;
	} catch {
		return [];
	}
}

async function findSessionLogFiles(root: string): Promise<string[]> {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		const files: string[] = [];

		for (const entry of entries) {
			const fullPath = join(root, entry.name);
			if (entry.isDirectory()) {
				files.push(...(await findSessionLogFiles(fullPath)));
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(fullPath);
			}
		}

		return files;
	} catch {
		return [];
	}
}

function makeTitleFromPrompt(prompt: string) {
	const firstLine = prompt.split("\n")[0]?.trim() || "Untitled session";
	return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}

function formatBytes(value: number) {
	if (value < 1024) {
		return `${value} B`;
	}
	if (value < 1024 * 1024) {
		return `${(value / 1024).toFixed(1)} KB`;
	}
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function createId(prefix: string) {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function escapeMarkdown(text: string) {
	return text.replace(/\\/g, "\\\\");
}
