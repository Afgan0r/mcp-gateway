import { replaceEnvVars } from '../config/index.js';
import { getUserDao } from '../dao/index.js';
import { hasCredentialTemplate } from '../utils/credentialTemplate.js';
import type { ServerConfig } from '../types/index.js';

const expandedEnvironments = new WeakSet<object>();

/** Ownerless operator configuration is trusted; missing owners fail closed. */
const getExpansionEnvironment = async (config: ServerConfig): Promise<Record<string, string>> => {
  const trusted =
    !config.owner || (await getUserDao().findByUsername(config.owner))?.isAdmin === true;
  const source = trusted ? process.env : {};
  return {
    ...(source as Record<string, string>),
    ...(hasCredentialTemplate(config) || (config.env && expandedEnvironments.has(config.env))
      ? config.env
      : replaceEnvVars(config.env || {}, source)),
  };
};

/** Keep child inheritance separate from trusted gateway-side placeholder expansion. */
export const getServerEnvironment = async (
  config: ServerConfig,
): Promise<Record<string, string>> => {
  const expanded = await getExpansionEnvironment(config);
  if (config.inheritEnv !== false) return expanded;
  // These are also the only variables merged by the SDK's stdio transport.
  const safeNames =
    process.platform === 'win32'
      ? [
          'APPDATA',
          'COMSPEC',
          'HOMEDRIVE',
          'HOMEPATH',
          'LOCALAPPDATA',
          'PATH',
          'PATHEXT',
          'PROCESSOR_ARCHITECTURE',
          'PROGRAMDATA',
          'PROGRAMFILES',
          'PROGRAMFILES(X86)',
          'PROGRAMW6432',
          'SYSTEMDRIVE',
          'SYSTEMROOT',
          'TEMP',
          'USERNAME',
          'USERPROFILE',
          'WINDIR',
        ]
      : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];
  const safe = Object.fromEntries(
    Object.entries(expanded).filter(
      ([name, value]) => safeNames.includes(name) && !value.startsWith('()'),
    ),
  );
  return {
    ...safe,
    ...Object.fromEntries(Object.keys(config.env ?? {}).map((name) => [name, expanded[name]])),
  };
};

export const expandServerConfig = async <T extends ServerConfig>(config: T): Promise<T> => {
  const { owner, visibility, sharedWithUsers, env, ...transportConfig } = config;
  const expansion = await getExpansionEnvironment(config);
  const resolvedEnv = env
    ? hasCredentialTemplate(config) || expandedEnvironments.has(env)
      ? { ...env }
      : replaceEnvVars(env, expansion)
    : undefined;
  if (resolvedEnv) expandedEnvironments.add(resolvedEnv);
  // Authorization metadata is literal and must never be controlled by expansion values.
  return {
    ...replaceEnvVars(transportConfig, expansion),
    ...(resolvedEnv ? { env: resolvedEnv } : {}),
    owner,
    visibility,
    sharedWithUsers,
  } as T;
};
