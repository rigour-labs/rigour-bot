import SmeeClient from 'smee-client';

export async function setupSmeeProxy(source: string, target: string): Promise<void> {
  const smee = new SmeeClient({
    source,
    target,
    logger: console,
  });

  smee.start();
}
