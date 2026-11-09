import assert from "node:assert/strict";
import test from "node:test";
import { chapterKey, countChars, resolveWithin, slugify } from "../paths.ts";

test("chapter keys", () => {
	assert.equal(chapterKey(1), "ch001");
	assert.equal(chapterKey(12), "ch012");
});

test("resolveWithin rejects escapes", () => {
	assert.equal(resolveWithin("/tmp/book", "chapters/ch001/final.md"), "/tmp/book/chapters/ch001/final.md");
	assert.throws(() => resolveWithin("/tmp/book", "../secret"), /非法路径|路径越界/);
	assert.throws(() => resolveWithin("/tmp/book", "/etc/passwd"), /非法路径/);
});

test("countChars handles CJK and latin", () => {
	assert.equal(countChars("你好 world"), 3);
});

test("slugify is filesystem safe", () => {
	assert.match(slugify("长夜将明"), /^book-\d{8}-\d{6}$/);
	assert.match(slugify("Hello World"), /^hello-world-\d{8}-\d{6}$/);
});
