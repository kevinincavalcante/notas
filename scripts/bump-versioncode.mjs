#!/usr/bin/env node
/**
 * Bump do versionCode do build local (APK Android).
 *
 * Guarda o número em android/notas-versioncode.txt (gitignored) e o
 * build.gradle lê via propriedade -PnotasVersionCode — assim o arquivo
 * commitado nunca fica sujo. Chão de fábrica: nada abaixo de 6 (o
 * Actions publicou até o v5).
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const counterPath = resolve(here, "..", "mobile", "android", "notas-versioncode.txt");

const current = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8").trim()) : 0;
const next = current < 6 ? 6 : current + 1;
writeFileSync(counterPath, String(next));
console.log(`versionCode: ${current} → ${next}`);
