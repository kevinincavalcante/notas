import {
  BoxClient,
  BoxJwtAuth,
  JwtConfig,
  BoxCcgAuth,
  CcgConfig,
} from "box-node-sdk";
import fs from "fs";

let boxClientInstance: BoxClient | null = null;

export function getBoxClient(): BoxClient | null {
  if (boxClientInstance) return boxClientInstance;

  const configJson = process.env.BOX_CONFIG_JSON;
  const configPath = process.env.BOX_CONFIG_PATH;

  if (configJson) {
    try {
      const jwtConfig = JwtConfig.fromConfigJsonString(configJson);
      const auth = new BoxJwtAuth({ config: jwtConfig });
      boxClientInstance = new BoxClient({ auth });
      return boxClientInstance;
    } catch (e) {
      console.error("Erro ao configurar Box via BOX_CONFIG_JSON:", e);
    }
  }

  if (configPath && fs.existsSync(configPath)) {
    try {
      const jwtConfig = JwtConfig.fromConfigFile(configPath);
      const auth = new BoxJwtAuth({ config: jwtConfig });
      boxClientInstance = new BoxClient({ auth });
      return boxClientInstance;
    } catch (e) {
      console.error("Erro ao carregar Box via BOX_CONFIG_PATH:", e);
    }
  }

  // Fallback: Box Client Credentials Grant (CCG)
  const clientId = process.env.BOX_CLIENT_ID;
  const clientSecret = process.env.BOX_CLIENT_SECRET;
  const enterpriseId = process.env.BOX_ENTERPRISE_ID;

  if (clientId && clientSecret && enterpriseId) {
    try {
      const ccgConfig = new CcgConfig({
        clientId,
        clientSecret,
        enterpriseId,
      });
      const auth = new BoxCcgAuth({ config: ccgConfig });
      boxClientInstance = new BoxClient({ auth });
      return boxClientInstance;
    } catch (e) {
      console.error("Erro ao configurar Box via CCG:", e);
    }
  }

  return null;
}

export const BOX_FOLDER_ID = process.env.BOX_FOLDER_ID || "0";
