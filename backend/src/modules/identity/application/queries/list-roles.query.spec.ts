import { IRbacRepository } from '../../domain/repositories/rbac.repository';
import { ListRolesQuery } from './list-roles.query';

describe('ListRolesQuery', () => {
  it('maps roles with their permission keys', async () => {
    const rbac = {
      listRoles: jest.fn().mockResolvedValue([
        {
          id: 'role-1',
          key: 'PHARMACIST',
          name: 'Pharmacist',
          scope: 'ORG',
          isSystem: true,
          description: null,
          permissionKeys: ['order:read:org', 'prescription:verify'],
        },
      ]),
    } as unknown as IRbacRepository;

    const result = await new ListRolesQuery(rbac).execute();

    expect(result).toEqual([
      {
        id: 'role-1',
        key: 'PHARMACIST',
        name: 'Pharmacist',
        scope: 'ORG',
        isSystem: true,
        description: null,
        permissions: ['order:read:org', 'prescription:verify'],
      },
    ]);
  });
});
