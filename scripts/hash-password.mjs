import bcrypt from "bcryptjs";

const password = process.argv[2] || "admin123";
const saltRounds = 10;

bcrypt.hash(password, saltRounds).then((hash) => {
  const escapedForEnv = hash.replace(/\$/g, "\\$");
  console.log(`\nSenha: ${password}`);
  console.log(`\nLinha para o seu .env.local (com escape para o Next.js):`);
  console.log(`APP_PASSWORD_HASH="${escapedForEnv}"\n`);
  console.log(`Dica: se preferir senha direta sem hash no .env.local:`);
  console.log(`APP_PASSWORD="${password}"\n`);
});
