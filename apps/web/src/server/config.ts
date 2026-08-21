export interface ReportApiConfig {
  databaseUrl: string;
  registryAddress: string;
  publicBaseUrl: string;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

type Environment = Readonly<Record<string, string | undefined>>;

function requiredEnvironmentValue(environment: Environment, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parsePublicBaseUrl(input: string): string {
  const url = new URL(input);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("FLIGHTCHECK_PUBLIC_BASE_URL must be an HTTP origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}

function parseRegistryAddress(input: string): string {
  if (!ADDRESS_PATTERN.test(input) || /^0x0{40}$/i.test(input)) {
    throw new Error("FLIGHTCHECK_REGISTRY_ADDRESS must be a nonzero EVM address.");
  }
  return input;
}

export function loadReportApiConfig(environment: Environment = process.env): ReportApiConfig {
  return {
    databaseUrl: requiredEnvironmentValue(environment, "DATABASE_URL"),
    registryAddress: parseRegistryAddress(requiredEnvironmentValue(environment, "FLIGHTCHECK_REGISTRY_ADDRESS")),
    publicBaseUrl: parsePublicBaseUrl(requiredEnvironmentValue(environment, "FLIGHTCHECK_PUBLIC_BASE_URL")),
  };
}
