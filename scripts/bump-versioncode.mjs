#!/usr/bin/env node
/**
 * Bump do versionCode no android/app/build.gradle (build local).
 * O versionCode precisa crescer a cada APK instalado por cima.
 * Chão de fábrica: o Actions publicou até o v5 (versionCode 5), então
 * nada abaixo de 6.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const gradlePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "mobile", "android", "app", "build.gradle");
const src = readFileSync(gradlePath, "utf8");
const m = /versionCode\s+(\d+)/.exec(src);
const current = m ? Number(m[1]) : 0;
const next = current < 6 ? 6 : current + 1;
writeFileSync(gradlePath, src.replace(/versionCode\s+\d+/, `versionCode ${next}`));
console.log(`versionCode: ${current} → ${next}`);
