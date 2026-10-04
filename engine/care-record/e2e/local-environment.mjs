const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
const apiUrlVariables = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL', 'API_URL'];
const databaseUrlVariables = ['SUPABASE_DB_URL', 'DATABASE_URL', 'POSTGRES_URL', 'DB_URL'];

function assertLoopbackUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid loopback URL for local E2E tests.`);
  }

  if (!localHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(`${name} must point to localhost or 127.0.0.1 for local E2E tests.`);
  }
}

export function assertLocalSupabaseEnvironment(env, { requireApi = true } = {}) {
  for (const name of apiUrlVariables) {
    if (env[name]) assertLoopbackUrl(env[name], name);
  }
  for (const name of databaseUrlVariables) {
    if (env[name]) assertLoopbackUrl(env[name], name);
  }

  if (requireApi && !env.NEXT_PUBLIC_SUPABASE_URL) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is required for E2E tests.');
  }
}
