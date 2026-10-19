import type { ServerConfigWithName } from '../../src/dao/index.js';

const mockRows = new Map<string, Record<string, unknown>>();
jest.mock('../../src/db/repositories/ServerRepository.js', () => ({
  ServerRepository: jest.fn().mockImplementation(() => ({
    create: async (row: Record<string, unknown> & { name: string }) => {
      mockRows.set(row.name, { ...row });
      return { ...row };
    },
    update: async (name: string, patch: Record<string, unknown>) => {
      const row = { ...mockRows.get(name), ...patch };
      mockRows.set(name, row);
      return { ...row };
    },
    findByName: async (name: string) => mockRows.get(name),
  })),
}));

import { ServerDaoDbImpl } from '../../src/dao/ServerDaoDbImpl.js';

it('round trips explicit child environment isolation through database create, read and partial updates', async () => {
  mockRows.clear();
  const dao = new ServerDaoDbImpl();
  const config: ServerConfigWithName = {
    name: 'fixture',
    type: 'stdio',
    command: 'node',
    inheritEnv: false,
  };
  expect((await dao.create(config)).inheritEnv).toBe(false);
  expect((await dao.findById('fixture'))!.inheritEnv).toBe(false);
  await dao.update('fixture', { description: 'Preserve isolation on unrelated edits' });
  expect((await dao.findById('fixture'))!.inheritEnv).toBe(false);
  await dao.update('fixture', { inheritEnv: true });
  expect((await dao.findById('fixture'))!.inheritEnv).toBe(true);
  await dao.update('fixture', { inheritEnv: false });
  expect((await dao.findById('fixture'))!.inheritEnv).toBe(false);
});
