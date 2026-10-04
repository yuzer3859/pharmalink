import { AccountStatus, PreferredLanguage, PrimaryRole } from '../enums';
import { User } from '../entities/user.entity';

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

/** Data required to create a brand-new user (credentials already hashed by the caller). */
export interface NewUserData {
  phone: string | null;
  email: string | null;
  passwordHash: string | null;
  primaryRole: PrimaryRole;
  status: AccountStatus;
  preferredLanguage: PreferredLanguage;
}

/**
 * What the admin user list may narrow by (module-16 Work 03). Each is a column `users` already
 * has; `identifier` is the same phone-or-email lookup `findByIdentifier` performs, exact match,
 * because Module 01 exposes no other user search and a substring search over contact details
 * would be a new capability rather than a filter over an existing one.
 */
export interface UserSearchFilter {
  status?: AccountStatus;
  primaryRole?: PrimaryRole;
  /** A normalized E.164 phone or a lowercased email — matched exactly. */
  identifier?: string;
}

export interface PaginatedUsers {
  items: User[];
  total: number;
  page: number;
  size: number;
}

/**
 * Persistence port for the User aggregate (module-01 §12). The domain depends on this interface;
 * the Prisma adapter implements it in the infrastructure layer (Dependency Inversion).
 */
export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByPhone(phone: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  /** Resolve by either a normalized phone (E.164) or a lowercased email. */
  findByIdentifier(identifier: string): Promise<User | null>;
  /** Filtered, paginated listing — newest account first, id as a tiebreaker. */
  search(filter: UserSearchFilter, page: number, size: number): Promise<PaginatedUsers>;
  create(data: NewUserData, tx?: unknown): Promise<User>;
  /** Persist mutable state of an existing aggregate. */
  save(user: User, tx?: unknown): Promise<void>;
}
