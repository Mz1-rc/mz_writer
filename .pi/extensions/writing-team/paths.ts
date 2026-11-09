import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function nowIso(): string {
	return new Date().toISOString();
}

export function timestampForId(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	);
}

export function slugify(title: string): string {
	const ascii = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${ascii || "book"}-${timestampForId()}`;
}

export function chapterKey(n: number): string {
	return `ch${String(Math.max(1, Math.trunc(n))).padStart(3, "0")}`;
}

export function chapterDir(n: number): string {
	return join("chapters", chapterKey(n));
}

export function chapterPrefix(n: number): string {
	return chapterKey(n);
}

export function expandChapterPlaceholder(target: string, n: number): string {
	return target.replaceAll("{chapter}", chapterKey(n));
}

export function ensureDir(path: string): string {
	mkdirSync(path, { recursive: true });
	return path;
}

export function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function writeAtomic(path: string, content: string): void {
	ensureDir(dirname(path));
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(tmp, content, "utf8");
	try {
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore cleanup failure
		}
		throw error;
	}
}

export function writeJsonAtomic(path: string, value: unknown): void {
	writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function fileExists(path: string): boolean {
	return existsSync(path);
}

export function fileStat(path: string): { size: number; mtimeMs: number } | undefined {
	try {
		const s = statSync(path);
		return { size: s.size, mtimeMs: s.mtimeMs };
	} catch {
		return undefined;
	}
}

/** Resolve a book-relative path, rejecting absolute paths and `..` escapes. */
export function resolveWithin(root: string, rel: string): string {
	const normalizedRel = rel.replaceAll("\\", "/");
	if (!normalizedRel || isAbsolute(normalizedRel) || normalizedRel.startsWith("/")) {
		throw new Error(`非法路径: ${rel}`);
	}
	const rootAbs = resolve(root);
	const target = resolve(rootAbs, normalizedRel);
	const relToRoot = relative(rootAbs, target);
	if (relToRoot.startsWith("..") || isAbsolute(relToRoot)) {
		throw new Error(`路径越界: ${rel}`);
	}
	return target;
}

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Approximate Chinese/Japanese/Korean + Latin word count. */
export function countChars(text: string): number {
	const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g)?.length ?? 0;
	const latin = text
		.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g, " ")
		.match(/[A-Za-z0-9]+/g)?.length ?? 0;
	return cjk + latin;
}

export function isStale(mtimeMs: number, maxAgeMs = 6 * 60 * 60 * 1000): boolean {
	return Date.now() - mtimeMs > maxAgeMs;
}
