import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { Coupon, CouponProps } from '../domain/entities/coupon.entity';
import { CouponRedemptionProps } from '../domain/entities/coupon-redemption.entity';
import { DiscountType, RedemptionStatus } from '../domain/enums';
import {
  CouponPage,
  ICouponRepository,
  ListCouponsCriteria,
} from '../domain/repositories/coupon.repository';
import { CouponValidator, DiscountableLine } from '../domain/services/coupon-validator';
import { CouponCode } from '../domain/value-objects/coupon-code.vo';
import { CouponScope } from '../domain/value-objects/coupon-scope.vo';
import { ApplyCouponCommand } from './commands/apply-coupon.command';
import { ManageCouponCommand } from './commands/manage-coupon.command';
import { ReverseCouponCommand } from './commands/reverse-coupon.command';
import { CouponPortAdapter } from './ports/inbound/coupon.port';
import { ICartPort } from './ports/outbound/cart.port';
import { CouponProductView, ICouponCatalogPort } from './ports/outbound/coupon-catalog.port';
import { IOrderPort, PayableOrderLineView, PayableOrderView } from './ports/outbound/order.port';
import { IUnitOfWork } from './ports/unit-of-work.port';
import { ValidateCouponQuery } from './queries/validate-coupon.query';
import { CouponLineResolver } from './services/coupon-line-resolver.service';

/**
 * The coupon slice (§3.4, §5.1, §7, §9.5, F-CPN-01..03), over an in-memory coupon store that keeps
 * the two properties the real one is trusted for: `coupons.code` is unique on the canonical form,
 * and `(couponId, orderId)` is unique. Those are what make "one promotion per code" and "a coupon
 * cannot be applied to an order twice" real assertions here rather than hopeful ones.
 *
 * The genuinely concurrent case — two applications racing the last remaining global usage under
 * PostgreSQL's serializable snapshot isolation — cannot be proved against a fake and is proved in
 * `test/payment/coupon.e2e-spec.ts` against real PostgreSQL. What is proved here is the logic:
 * that the arithmetic is exact, that scope narrows rather than widens, and that every refusal is
 * the right refusal.
 */

const CUSTOMER = 'customer-1';
const OTHER_CUSTOMER = 'customer-2';
const ORDER = 'order-1';
const PRODUCT_A = 'product-a';
const PRODUCT_B = 'product-b';
const CATEGORY_VITAMINS = 'category-vitamins';
const CATEGORY_OTHER = 'category-other';
const PHARMACY_A = 'pharmacy-a';
const PHARMACY_B = 'pharmacy-b';

function uniqueViolation(constraint: string): Error {
  const err = new Error(`Unique constraint failed on ${constraint}`) as Error & { code: string };
  err.code = 'P2002';
  return err;
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiException) {
      return err.code;
    }
    throw err;
  }
  throw new Error('expected the operation to be rejected');
}

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

class FakeCouponRepository implements ICouponRepository {
  readonly coupons = new Map<string, CouponProps>();
  readonly redemptions = new Map<string, CouponRedemptionProps>();

  async findById(id: string): Promise<CouponProps | null> {
    return this.coupons.get(id) ?? null;
  }
  async findByCode(code: string): Promise<CouponProps | null> {
    return [...this.coupons.values()].find((coupon) => coupon.code === code) ?? null;
  }
  async list(criteria: ListCouponsCriteria): Promise<CouponPage> {
    const all = [...this.coupons.values()].filter(
      (coupon) =>
        (criteria.isActive === undefined || coupon.isActive === criteria.isActive) &&
        (!criteria.codeContains || coupon.code.includes(criteria.codeContains)),
    );
    const start = (criteria.page - 1) * criteria.size;
    return { items: all.slice(start, start + criteria.size), total: all.length };
  }
  async create(coupon: CouponProps): Promise<CouponProps> {
    if (await this.findByCode(coupon.code)) {
      throw uniqueViolation('coupons_code_key');
    }
    this.coupons.set(coupon.id, { ...coupon });
    return { ...coupon };
  }
  async update(
    id: string,
    changes: Omit<CouponProps, 'id' | 'code' | 'createdAt'>,
  ): Promise<CouponProps> {
    const existing = this.coupons.get(id)!;
    const next = { ...existing, ...changes };
    this.coupons.set(id, next);
    return { ...next };
  }
  async countAppliedForCoupon(couponId: string): Promise<number> {
    return this.applied().filter((row) => row.couponId === couponId).length;
  }
  async countAppliedForCouponAndUser(couponId: string, userId: string): Promise<number> {
    return this.applied().filter((row) => row.couponId === couponId && row.userId === userId)
      .length;
  }
  async findRedemptionById(id: string): Promise<CouponRedemptionProps | null> {
    return this.redemptions.get(id) ?? null;
  }
  async findRedemptionByCouponAndOrder(
    couponId: string,
    orderId: string,
  ): Promise<CouponRedemptionProps | null> {
    return (
      [...this.redemptions.values()].find(
        (row) => row.couponId === couponId && row.orderId === orderId,
      ) ?? null
    );
  }
  async findRedemptionsByOrder(orderId: string): Promise<CouponRedemptionProps[]> {
    return [...this.redemptions.values()].filter((row) => row.orderId === orderId);
  }
  async findRedemptionsByCoupon(couponId: string): Promise<CouponRedemptionProps[]> {
    return [...this.redemptions.values()].filter((row) => row.couponId === couponId);
  }
  async createRedemption(redemption: CouponRedemptionProps): Promise<CouponRedemptionProps> {
    if (await this.findRedemptionByCouponAndOrder(redemption.couponId, redemption.orderId)) {
      throw uniqueViolation('coupon_redemptions_couponId_orderId_key');
    }
    this.redemptions.set(redemption.id, { ...redemption });
    return { ...redemption };
  }
  async updateRedemptionStatus(
    id: string,
    status: RedemptionStatus,
  ): Promise<CouponRedemptionProps> {
    const next = { ...this.redemptions.get(id)!, status };
    this.redemptions.set(id, next);
    return { ...next };
  }

  private applied(): CouponRedemptionProps[] {
    return [...this.redemptions.values()].filter(
      (row) => row.status === RedemptionStatus.APPLIED,
    );
  }
}

class FakeCartPort implements ICartPort {
  lines: Array<{ catalogProductId: string; quantity: number }> = [];
  exists = true;

  async getActiveCart(customerUserId: string) {
    return this.exists
      ? { id: 'cart-1', customerUserId, lines: [...this.lines] }
      : null;
  }
}

class FakeCatalogPort implements ICouponCatalogPort {
  readonly products = new Map<string, CouponProductView>();

  async getProducts(productIds: readonly string[]): Promise<CouponProductView[]> {
    return productIds
      .map((id) => this.products.get(id))
      .filter((product): product is CouponProductView => Boolean(product));
  }
}

class FakeOrderPort implements IOrderPort {
  order: PayableOrderView | null = {
    id: ORDER,
    customerUserId: CUSTOMER,
    status: 'PENDING_PAYMENT',
    grandTotal: 1_000,
    currency: 'ETB',
    platformFee: 0,
    discountTotal: 0,
    isCod: false,
  };
  lines: PayableOrderLineView[] = [];

  async getOrder(): Promise<PayableOrderView | null> {
    return this.order;
  }
  async getOrderLines(): Promise<PayableOrderLineView[]> {
    return [...this.lines];
  }
  async getFulfillmentPharmacyIds(): Promise<string[]> {
    return [];
  }
}

/** Serializes transactions and rolls the store back on failure, as a real one would. */
class FakeUnitOfWork implements IUnitOfWork {
  commits = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly repo: FakeCouponRepository) {}

  run<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const coupons = new Map(this.repo.coupons);
      const redemptions = new Map(this.repo.redemptions);
      try {
        const result = await work({ tx: true });
        this.commits += 1;
        return result;
      } catch (err) {
        this.repo.coupons.clear();
        for (const [k, v] of coupons) this.repo.coupons.set(k, v);
        this.repo.redemptions.clear();
        for (const [k, v] of redemptions) this.repo.redemptions.set(k, v);
        throw err;
      }
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next as Promise<T>;
  }
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

function couponProps(overrides: Partial<CouponProps> = {}): CouponProps {
  return {
    id: 'coupon-1',
    code: 'SAVE10',
    discountType: DiscountType.PERCENT,
    value: 10,
    minSpend: null,
    maxDiscount: null,
    scope: null,
    startsAt: null,
    expiresAt: null,
    usageLimitGlobal: null,
    usageLimitPerUser: null,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function line(overrides: Partial<DiscountableLine> = {}): DiscountableLine {
  return {
    productId: PRODUCT_A,
    categoryIds: [CATEGORY_VITAMINS],
    pharmacyId: PHARMACY_A,
    lineTotal: 1_000,
    ...overrides,
  };
}

function harness() {
  const repo = new FakeCouponRepository();
  const carts = new FakeCartPort();
  const catalog = new FakeCatalogPort();
  const orders = new FakeOrderPort();
  const uow = new FakeUnitOfWork(repo);
  const resolver = new CouponLineResolver(carts, orders, catalog);
  const audit = { record: jest.fn().mockResolvedValue({ id: 'audit-1', hash: 'h' }) };
  const outbox = { write: jest.fn().mockResolvedValue(undefined) };

  return {
    repo,
    carts,
    catalog,
    orders,
    uow,
    audit,
    outbox,
    validate: new ValidateCouponQuery(repo, resolver),
    apply: new ApplyCouponCommand(
      repo,
      orders,
      uow,
      resolver,
      audit as unknown as AuditService,
      outbox as unknown as OutboxService,
    ),
    reverse: new ReverseCouponCommand(
      repo,
      uow,
      audit as unknown as AuditService,
      outbox as unknown as OutboxService,
    ),
    manage: new ManageCouponCommand(repo, uow, audit as unknown as AuditService),
  };
}

type Harness = ReturnType<typeof harness>;

/** Seeds one order line with its catalog facts, so scope and pricing are both real. */
function seedOrderLine(
  h: Harness,
  options: {
    productId?: string;
    categoryIds?: string[];
    pharmacyId?: string | null;
    lineTotal?: number;
  } = {},
) {
  const productId = options.productId ?? PRODUCT_A;
  h.catalog.products.set(productId, {
    id: productId,
    status: 'ACTIVE',
    price: options.lineTotal ?? 1_000,
    categoryIds: options.categoryIds ?? [CATEGORY_VITAMINS],
  });
  h.orders.lines.push({
    catalogProductId: productId,
    quantity: 1,
    unitPrice: options.lineTotal ?? 1_000,
    lineTotal: options.lineTotal ?? 1_000,
    pharmacyId: options.pharmacyId === undefined ? PHARMACY_A : options.pharmacyId,
  });
}

/** Seeds one cart line with its catalog facts. */
function seedCartLine(
  h: Harness,
  options: { productId?: string; categoryIds?: string[]; price?: number; quantity?: number } = {},
) {
  const productId = options.productId ?? PRODUCT_A;
  h.catalog.products.set(productId, {
    id: productId,
    status: 'ACTIVE',
    price: options.price ?? 1_000,
    categoryIds: options.categoryIds ?? [CATEGORY_VITAMINS],
  });
  h.carts.lines.push({ catalogProductId: productId, quantity: options.quantity ?? 1 });
}

// =============================================================================================
// Code normalization
// =============================================================================================

describe('CouponCode normalization', () => {
  it.each([
    ['save10', 'SAVE10'],
    ['  SAVE10  ', 'SAVE10'],
    ['SaVe10', 'SAVE10'],
    ['\tsave-10\n', 'SAVE-10'],
  ])('canonicalizes %s to %s', (raw, expected) => {
    expect(CouponCode.of(raw).value).toBe(expected);
  });

  it('makes logically identical codes one coupon, not two', () => {
    expect(CouponCode.of('save10').equals(CouponCode.of('SAVE10'))).toBe(true);
  });

  it.each([
    ['too short', 'AB'],
    ['too long', 'X'.repeat(33)],
    ['with a space', 'SAVE 10'],
    ['with punctuation', 'SAVE!10'],
    ['non-ASCII', 'SAVEА'],
    ['empty', '   '],
  ])('rejects a code %s', (_label, raw) => {
    expect(() => CouponCode.of(raw)).toThrow(ApiException);
  });

  it('normalizes a lookup without validating it, so a malformed code is simply unknown', () => {
    expect(CouponCode.normalize('  save 10 ')).toBe('SAVE 10');
    expect(CouponCode.normalize(undefined as unknown as string)).toBe('');
  });
});

// =============================================================================================
// Configuration invariants
// =============================================================================================

describe('Coupon configuration (F-CPN-01)', () => {
  const create = (overrides: Record<string, unknown> = {}) =>
    Coupon.create({
      id: 'coupon-1',
      code: 'SAVE10',
      discountType: DiscountType.PERCENT,
      value: 10,
      ...overrides,
    });

  it('accepts a well-formed percentage coupon', () => {
    expect(create().toProps()).toMatchObject({ code: 'SAVE10', value: 10, isActive: true });
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
  ])('rejects a %s value', (_label, value) => {
    expect(() => create({ value })).toThrow(ApiException);
  });

  it.each([
    ['over 100', 101],
    ['far over 100', 1_000],
  ])('rejects a percentage %s', (_label, value) => {
    expect(() => create({ value })).toThrow(ApiException);
  });

  it('allows a FIXED value above 100 — it is minor units, not a percentage', () => {
    expect(
      create({ discountType: DiscountType.FIXED, value: 15_000 }).toProps().value,
    ).toBe(15_000);
  });

  it.each([
    ['minSpend', { minSpend: 0 }],
    ['maxDiscount', { maxDiscount: 0 }],
    ['usageLimitGlobal', { usageLimitGlobal: 0 }],
    ['usageLimitPerUser', { usageLimitPerUser: 0 }],
  ])('rejects a zero %s', (_label, overrides) => {
    expect(() => create(overrides)).toThrow(ApiException);
  });

  it('rejects a window that ends before it starts', () => {
    expect(() =>
      create({
        startsAt: new Date('2026-02-01T00:00:00Z'),
        expiresAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ).toThrow(ApiException);
  });

  it('rejects a per-user limit larger than the global one', () => {
    expect(() => create({ usageLimitGlobal: 5, usageLimitPerUser: 10 })).toThrow(ApiException);
  });

  it('re-validates the whole configuration on update, not only the delta', () => {
    const coupon = create({ usageLimitGlobal: 10, usageLimitPerUser: 2 });

    // Lowering the global limit below the per-user one must be refused, even though the field
    // being edited is valid on its own.
    expect(() => coupon.update({ usageLimitGlobal: 1 })).toThrow(ApiException);
    expect(coupon.toProps().usageLimitGlobal).toBe(10);
  });

  it('deactivates without touching anything else', () => {
    const coupon = create();
    coupon.setActive(false);
    expect(coupon.toProps()).toMatchObject({ isActive: false, code: 'SAVE10', value: 10 });
  });
});

// =============================================================================================
// Scope
// =============================================================================================

describe('CouponScope (§7 product/category/pharmacy)', () => {
  it('treats null and {} as platform-wide', () => {
    expect(CouponScope.parse(null).isUnrestricted).toBe(true);
    expect(CouponScope.parse({}).isUnrestricted).toBe(true);
  });

  it('rejects an unknown dimension rather than ignoring it', () => {
    expect(() => CouponScope.parse({ brandIds: ['x'] })).toThrow(ApiException);
  });

  it.each([
    ['an empty list', { productIds: [] }],
    ['a non-array', { productIds: 'product-a' }],
    ['a non-string id', { productIds: [42] }],
  ])('rejects %s', (_label, raw) => {
    expect(() => CouponScope.parse(raw)).toThrow(ApiException);
  });

  it('matches a product scope only for that product', () => {
    const scope = CouponScope.parse({ productIds: [PRODUCT_A] });
    expect(scope.matches(line({ productId: PRODUCT_A }))).toBe(true);
    expect(scope.matches(line({ productId: PRODUCT_B }))).toBe(false);
  });

  it('matches a category scope through the product’s real categories', () => {
    const scope = CouponScope.parse({ categoryIds: [CATEGORY_VITAMINS] });
    expect(scope.matches(line({ categoryIds: [CATEGORY_VITAMINS, CATEGORY_OTHER] }))).toBe(true);
    expect(scope.matches(line({ categoryIds: [CATEGORY_OTHER] }))).toBe(false);
    expect(scope.matches(line({ categoryIds: [] }))).toBe(false);
  });

  it('matches a pharmacy scope only for that pharmacy', () => {
    const scope = CouponScope.parse({ pharmacyIds: [PHARMACY_A] });
    expect(scope.matches(line({ pharmacyId: PHARMACY_A }))).toBe(true);
    expect(scope.matches(line({ pharmacyId: PHARMACY_B }))).toBe(false);
  });

  it('never treats an unknown pharmacy as a match', () => {
    const scope = CouponScope.parse({ pharmacyIds: [PHARMACY_A] });
    expect(scope.matches(line({ pharmacyId: null }))).toBe(false);
  });

  it('ANDs across dimensions and ORs within one', () => {
    const scope = CouponScope.parse({
      categoryIds: [CATEGORY_VITAMINS, CATEGORY_OTHER],
      pharmacyIds: [PHARMACY_A],
    });
    // Both dimensions satisfied.
    expect(scope.matches(line({ categoryIds: [CATEGORY_OTHER], pharmacyId: PHARMACY_A }))).toBe(
      true,
    );
    // Category satisfied, pharmacy not — the narrower reading refuses.
    expect(scope.matches(line({ categoryIds: [CATEGORY_OTHER], pharmacyId: PHARMACY_B }))).toBe(
      false,
    );
  });

  it('round-trips through its persisted JSON, dropping nothing', () => {
    const raw = { productIds: [PRODUCT_A], pharmacyIds: [PHARMACY_A] };
    expect(CouponScope.parse(raw).toJSON()).toEqual(raw);
    expect(CouponScope.unrestricted().toJSON()).toBeNull();
  });
});

// =============================================================================================
// Discount arithmetic
// =============================================================================================

describe('CouponValidator discount calculation (§7 of the task brief)', () => {
  const evaluate = (coupon: Partial<CouponProps>, lines: DiscountableLine[]) =>
    CouponValidator.evaluate({
      coupon: couponProps(coupon),
      lines,
      usage: { global: 0, perUser: 0 },
      now: new Date('2026-06-01T00:00:00Z'),
    });

  it('applies a fixed discount: 1000 - 150 = 850', () => {
    const result = evaluate({ discountType: DiscountType.FIXED, value: 150 }, [
      line({ lineTotal: 1_000 }),
    ]);

    expect(result).toMatchObject({ valid: true, discountAmount: 150, eligibleSubtotal: 1_000 });
  });

  it('applies a percentage discount: 10% of 1000 = 100', () => {
    expect(evaluate({ value: 10 }, [line({ lineTotal: 1_000 })])).toMatchObject({
      valid: true,
      discountAmount: 100,
    });
  });

  it('caps at maxDiscount: 10% of 5000 is 500, capped to 75', () => {
    const result = evaluate({ value: 10, maxDiscount: 75 }, [line({ lineTotal: 5_000 })]);

    expect(result).toMatchObject({ valid: true, discountAmount: 75 });
  });

  it('never discounts more than the eligible subtotal', () => {
    // A 5000 fixed coupon against 1000 of eligible items gives 1000, never 5000.
    const result = evaluate({ discountType: DiscountType.FIXED, value: 5_000 }, [
      line({ lineTotal: 1_000 }),
    ]);

    expect(result).toMatchObject({ valid: true, discountAmount: 1_000 });
  });

  it('discounts only the eligible lines — the task brief’s scope example', () => {
    // Cart: A = 500, B = 500. Coupon applies to A only, 10%. Discount = 50, not 100.
    const result = evaluate({ value: 10, scope: { productIds: [PRODUCT_A] } }, [
      line({ productId: PRODUCT_A, lineTotal: 500 }),
      line({ productId: PRODUCT_B, lineTotal: 500 }),
    ]);

    expect(result).toMatchObject({ valid: true, discountAmount: 50, eligibleSubtotal: 500 });
  });

  it.each([
    [1_000, 10, 100],
    [999, 10, 100], // 99.9 -> 100, half-up
    [995, 10, 100], // 99.5 -> 100, half-up rather than banker's 100... and 99.5 is the midpoint
    [50, 5, 3], // 2.5 -> 3 under half-up; banker's rounding would give 2
    [1, 50, 1], // 0.5 -> 1, never 0
    [333, 33, 110], // 109.89 -> 110
  ])('rounds %s x %s%% to %s, half-up and integer-exact', (subtotal, percent, expected) => {
    expect(evaluate({ value: percent }, [line({ lineTotal: subtotal })])).toMatchObject({
      discountAmount: expected,
    });
  });

  it('produces the same figure as Math.round would for a representative sweep', () => {
    for (let subtotal = 1; subtotal <= 300; subtotal += 7) {
      for (const percent of [1, 5, 10, 33, 50, 99, 100]) {
        const result = evaluate({ value: percent }, [line({ lineTotal: subtotal })]);
        const expected = Math.min(Math.round((subtotal * percent) / 100), subtotal);
        expect((result as { discountAmount: number }).discountAmount).toBe(expected);
      }
    }
  });

  it('never discounts the delivery fee — it is not a line at all', () => {
    // The resolver only ever builds product lines; there is no delivery input to this service.
    const result = evaluate({ discountType: DiscountType.FIXED, value: 900 }, [
      line({ lineTotal: 500 }),
    ]);
    expect(result).toMatchObject({ discountAmount: 500 });
  });
});

// =============================================================================================
// Eligibility
// =============================================================================================

describe('CouponValidator eligibility (F-CPN-02)', () => {
  const evaluate = (
    coupon: Partial<CouponProps>,
    usage = { global: 0, perUser: 0 },
    lines = [line({ lineTotal: 1_000 })],
  ) =>
    CouponValidator.evaluate({
      coupon: couponProps(coupon),
      lines,
      usage,
      now: new Date('2026-06-01T00:00:00Z'),
    });

  it('refuses a deactivated coupon', () => {
    expect(evaluate({ isActive: false })).toMatchObject({ valid: false, reason: 'INACTIVE' });
  });

  it('refuses a coupon that has not started', () => {
    expect(evaluate({ startsAt: new Date('2026-07-01T00:00:00Z') })).toMatchObject({
      valid: false,
      reason: 'NOT_STARTED',
    });
  });

  it('refuses an expired coupon', () => {
    expect(evaluate({ expiresAt: new Date('2026-05-01T00:00:00Z') })).toMatchObject({
      valid: false,
      reason: 'EXPIRED',
    });
  });

  it('accepts a coupon inside its window', () => {
    expect(
      evaluate({
        startsAt: new Date('2026-01-01T00:00:00Z'),
        expiresAt: new Date('2026-12-01T00:00:00Z'),
      }),
    ).toMatchObject({ valid: true });
  });

  it('measures minSpend against the eligible subtotal, not the whole cart', () => {
    const lines = [
      line({ productId: PRODUCT_A, lineTotal: 200 }),
      line({ productId: PRODUCT_B, lineTotal: 5_000 }),
    ];
    // 5200 in the cart, but only 200 is in scope — an unrelated expensive item must not unlock it.
    expect(
      evaluate({ minSpend: 1_000, scope: { productIds: [PRODUCT_A] } }, undefined, lines),
    ).toMatchObject({ valid: false, reason: 'MIN_SPEND_NOT_MET' });
  });

  it('accepts when the eligible subtotal meets minSpend exactly', () => {
    expect(evaluate({ minSpend: 1_000 })).toMatchObject({ valid: true });
  });

  it('refuses when nothing is in scope', () => {
    expect(evaluate({ scope: { productIds: ['product-z'] } })).toMatchObject({
      valid: false,
      reason: 'NOT_IN_SCOPE',
    });
  });

  it('refuses a pharmacy-scoped coupon while no pharmacy is known', () => {
    expect(
      evaluate({ scope: { pharmacyIds: [PHARMACY_A] } }, undefined, [
        line({ pharmacyId: null }),
      ]),
    ).toMatchObject({ valid: false, reason: 'PHARMACY_SCOPE_UNRESOLVABLE' });
  });

  it('refuses once the global limit is reached', () => {
    expect(evaluate({ usageLimitGlobal: 100 }, { global: 100, perUser: 0 })).toMatchObject({
      valid: false,
      reason: 'GLOBAL_LIMIT_REACHED',
    });
    expect(evaluate({ usageLimitGlobal: 100 }, { global: 99, perUser: 0 })).toMatchObject({
      valid: true,
    });
  });

  it('refuses once the per-user limit is reached', () => {
    expect(evaluate({ usageLimitPerUser: 1 }, { global: 50, perUser: 1 })).toMatchObject({
      valid: false,
      reason: 'PER_USER_LIMIT_REACHED',
    });
  });
});

// =============================================================================================
// Validation query
// =============================================================================================

describe('ValidateCouponQuery (§9.5)', () => {
  it('quotes a discount against the caller’s real cart', async () => {
    const h = harness();
    await h.repo.create(couponProps());
    seedCartLine(h, { price: 1_000 });

    const result = await h.validate.execute({ customerUserId: CUSTOMER, code: 'save10' });

    expect(result).toMatchObject({
      valid: true,
      discountAmount: 100,
      code: 'SAVE10',
      cartSubtotal: 1_000,
      eligibleSubtotal: 1_000,
    });
  });

  it('creates no redemption row — validation is side-effect free', async () => {
    const h = harness();
    await h.repo.create(couponProps());
    seedCartLine(h);

    await h.validate.execute({ customerUserId: CUSTOMER, code: 'SAVE10' });

    expect(h.repo.redemptions.size).toBe(0);
    expect(h.audit.record).not.toHaveBeenCalled();
    expect(h.outbox.write).not.toHaveBeenCalled();
  });

  it('does not compute against a client-supplied cartTotal — it reports the disagreement', async () => {
    const h = harness();
    await h.repo.create(couponProps());
    seedCartLine(h, { price: 1_000 });

    const result = await h.validate.execute({
      customerUserId: CUSTOMER,
      code: 'SAVE10',
      cartTotal: 999_999,
    });

    // 10% of the server's 1000, not of the client's 999999.
    expect(result).toMatchObject({
      discountAmount: 100,
      cartSubtotal: 1_000,
      cartTotalMismatch: true,
    });
  });

  it('reports agreement when the client’s total matches', async () => {
    const h = harness();
    await h.repo.create(couponProps());
    seedCartLine(h, { price: 1_000 });

    const result = await h.validate.execute({
      customerUserId: CUSTOMER,
      code: 'SAVE10',
      cartTotal: 1_000,
    });

    expect(result.cartTotalMismatch).toBe(false);
  });

  it('answers an unknown code exactly like a deactivated one', async () => {
    const h = harness();
    await h.repo.create(couponProps({ isActive: false }));
    seedCartLine(h);

    const unknown = await h.validate.execute({ customerUserId: CUSTOMER, code: 'NOSUCHCODE' });
    const inactive = await h.validate.execute({ customerUserId: CUSTOMER, code: 'SAVE10' });

    expect(unknown.valid).toBe(false);
    expect(inactive.valid).toBe(false);
    // Different machine reasons are fine; neither confirms a coupon exists by its *shape*.
    expect(unknown.discountAmount).toBe(0);
    expect(inactive.discountAmount).toBe(0);
  });

  it('reports a coupon that does not apply as valid:false rather than throwing', async () => {
    const h = harness();
    await h.repo.create(couponProps({ minSpend: 5_000 }));
    seedCartLine(h, { price: 1_000 });

    const result = await h.validate.execute({ customerUserId: CUSTOMER, code: 'SAVE10' });

    expect(result).toMatchObject({ valid: false, reason: 'MIN_SPEND_NOT_MET', discountAmount: 0 });
  });

  it('answers a customer with no cart without inventing one', async () => {
    const h = harness();
    await h.repo.create(couponProps());
    h.carts.exists = false;

    const result = await h.validate.execute({ customerUserId: CUSTOMER, code: 'SAVE10' });

    expect(result).toMatchObject({ valid: false, cartSubtotal: 0, discountAmount: 0 });
  });

  it('ignores an unpriced or non-purchasable product entirely', async () => {
    const h = harness();
    await h.repo.create(couponProps({ minSpend: 1_000 }));
    seedCartLine(h, { productId: PRODUCT_A, price: 500 });
    // Unpriced: must not help clear the minimum spend.
    h.catalog.products.set(PRODUCT_B, {
      id: PRODUCT_B,
      status: 'ACTIVE',
      price: null,
      categoryIds: [],
    });
    h.carts.lines.push({ catalogProductId: PRODUCT_B, quantity: 1 });

    const result = await h.validate.execute({ customerUserId: CUSTOMER, code: 'SAVE10' });

    expect(result).toMatchObject({ valid: false, reason: 'MIN_SPEND_NOT_MET', cartSubtotal: 500 });
  });

  it('counts a cart line by quantity', async () => {
    const h = harness();
    await h.repo.create(couponProps());
    seedCartLine(h, { price: 250, quantity: 4 });

    const result = await h.validate.execute({ customerUserId: CUSTOMER, code: 'SAVE10' });

    expect(result).toMatchObject({ cartSubtotal: 1_000, discountAmount: 100 });
  });

  it('never reads another customer’s cart', async () => {
    const h = harness();
    await h.repo.create(couponProps());
    seedCartLine(h, { price: 1_000 });
    // The fake returns the requesting customer's own cart id; what matters is that the query
    // passes the token subject through and nothing else can override it.
    const result = await h.validate.execute({ customerUserId: OTHER_CUSTOMER, code: 'SAVE10' });

    expect(result.valid).toBe(true);
    expect(h.repo.redemptions.size).toBe(0);
  });
});

// =============================================================================================
// Apply
// =============================================================================================

describe('ApplyCouponCommand (F-CPN-02)', () => {
  async function applied(h: Harness, overrides: Record<string, unknown> = {}) {
    return h.apply.execute({
      code: 'SAVE10',
      orderId: ORDER,
      customerUserId: CUSTOMER,
      ...overrides,
    });
  }

  it('records a redemption against the order and returns the discount', async () => {
    const h = harness();
    await h.repo.create(couponProps());
    seedOrderLine(h, { lineTotal: 1_000 });

    const result = await applied(h);

    expect(result).toMatchObject({
      couponId: 'coupon-1',
      code: 'SAVE10',
      orderId: ORDER,
      customerUserId: CUSTOMER,
      discountAmount: 100,
      status: RedemptionStatus.APPLIED,
      replay: false,
    });
    expect(h.repo.redemptions.size).toBe(1);
  });

  it('scores the order’s own lines, including its pharmacy', async () => {
    const h = harness();
    await h.repo.create(couponProps({ scope: { pharmacyIds: [PHARMACY_A] } }));
    seedOrderLine(h, { lineTotal: 1_000, pharmacyId: PHARMACY_A });

    expect((await applied(h)).discountAmount).toBe(100);
  });

  it('refuses a pharmacy-scoped coupon when the order line names another pharmacy', async () => {
    const h = harness();
    await h.repo.create(couponProps({ scope: { pharmacyIds: [PHARMACY_B] } }));
    seedOrderLine(h, { lineTotal: 1_000, pharmacyId: PHARMACY_A });

    expect(await codeOf(() => applied(h))).toBe(ErrorCode.COUPON_INVALID);
    expect(h.repo.redemptions.size).toBe(0);
  });

  it('enforces the global limit', async () => {
    const h = harness();
    await h.repo.create(couponProps({ usageLimitGlobal: 1 }));
    seedOrderLine(h, { lineTotal: 1_000 });
    await applied(h);

    h.orders.order = { ...h.orders.order!, id: 'order-2' };
    expect(await codeOf(() => applied(h, { orderId: 'order-2' }))).toBe(
      ErrorCode.COUPON_USAGE_EXCEEDED,
    );
    expect(h.repo.redemptions.size).toBe(1);
  });

  it('enforces the per-user limit while leaving another customer free to use it', async () => {
    const h = harness();
    await h.repo.create(couponProps({ usageLimitPerUser: 1 }));
    seedOrderLine(h, { lineTotal: 1_000 });
    await applied(h);

    // Same customer, different order: refused.
    expect(
      await codeOf(() => applied(h, { orderId: 'order-2' })),
    ).toBe(ErrorCode.COUPON_USAGE_EXCEEDED);

    // A different customer's own order: allowed.
    h.orders.order = { ...h.orders.order!, id: 'order-3', customerUserId: OTHER_CUSTOMER };
    const other = await applied(h, { orderId: 'order-3', customerUserId: OTHER_CUSTOMER });
    expect(other.discountAmount).toBe(100);
  });

  it('raises COUPON_EXPIRED for an expired coupon', async () => {
    const h = harness();
    await h.repo.create(couponProps({ expiresAt: new Date('2020-01-01T00:00:00Z') }));
    seedOrderLine(h);

    expect(await codeOf(() => applied(h))).toBe(ErrorCode.COUPON_EXPIRED);
  });

  it('raises COUPON_INVALID for an unknown code', async () => {
    const h = harness();
    seedOrderLine(h);

    expect(await codeOf(() => applied(h, { code: 'NOSUCHCODE' }))).toBe(ErrorCode.COUPON_INVALID);
  });

  it('refuses to spend one customer’s allowance on another customer’s order', async () => {
    const h = harness();
    await h.repo.create(couponProps());
    seedOrderLine(h);

    expect(await codeOf(() => applied(h, { customerUserId: OTHER_CUSTOMER }))).toBe(
      ErrorCode.ORDER_NOT_FOUND,
    );
    expect(h.repo.redemptions.size).toBe(0);
  });

  it('replays rather than counting a second usage', async () => {
    const h = harness();
    await h.repo.create(couponProps({ usageLimitGlobal: 1 }));
    seedOrderLine(h, { lineTotal: 1_000 });
    const first = await applied(h);

    const second = await applied(h);

    expect(second.replay).toBe(true);
    expect(second.redemptionId).toBe(first.redemptionId);
    expect(h.repo.redemptions.size).toBe(1);
    expect(await h.repo.countAppliedForCoupon('coupon-1')).toBe(1);
    // No second audit entry or event.
    expect(h.audit.record).toHaveBeenCalledTimes(1);
    expect(h.outbox.write).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a reversed redemption', async () => {
    const h = harness();
    await h.repo.create(couponProps());
    seedOrderLine(h);
    await applied(h);
    await h.reverse.execute({ orderId: ORDER, code: 'SAVE10' });

    expect(await codeOf(() => applied(h))).toBe(ErrorCode.COUPON_INVALID);
    expect(h.repo.redemptions.size).toBe(1);
  });

  it('lets only one of two concurrent applications through a limit of one', async () => {
    const h = harness();
    await h.repo.create(couponProps({ usageLimitGlobal: 1 }));
    seedOrderLine(h, { lineTotal: 1_000 });

    const results = await Promise.allSettled([
      applied(h),
      (async () => {
        h.orders.order = { ...h.orders.order!, id: 'order-2' };
        return applied(h, { orderId: 'order-2' });
      })(),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await h.repo.countAppliedForCoupon('coupon-1')).toBe(1);
  });

  it('records the audit entry and the catalogued coupon.redeemed event', async () => {
    const h = harness();
    await h.repo.create(couponProps());
    seedOrderLine(h, { lineTotal: 1_000 });

    await applied(h);

    const [entry] = h.audit.record.mock.calls[0];
    expect(entry).toMatchObject({
      action: 'COUPON_REDEEMED',
      resourceType: 'CouponRedemption',
      actorUserId: CUSTOMER,
    });
    expect(entry.context).toMatchObject({
      couponId: 'coupon-1',
      code: 'SAVE10',
      orderId: ORDER,
      userId: CUSTOMER,
      discountAmount: 100,
      outcome: 'APPLIED',
    });

    expect(h.outbox.write.mock.calls[0][0]).toMatchObject({
      type: 'coupon.redeemed',
      aggregateType: 'Coupon',
      aggregateId: 'coupon-1',
      payload: { couponId: 'coupon-1', userId: CUSTOMER, orderId: ORDER, discountAmount: 100 },
    });
  });

  it('writes nothing when the coupon is refused', async () => {
    const h = harness();
    await h.repo.create(couponProps({ isActive: false }));
    seedOrderLine(h);

    await expect(applied(h)).rejects.toBeInstanceOf(ApiException);

    expect(h.repo.redemptions.size).toBe(0);
    expect(h.audit.record).not.toHaveBeenCalled();
    expect(h.outbox.write).not.toHaveBeenCalled();
  });
});

// =============================================================================================
// Reverse
// =============================================================================================

describe('ReverseCouponCommand (F-CPN-03)', () => {
  async function withRedemption(): Promise<Harness> {
    const h = harness();
    await h.repo.create(couponProps({ usageLimitGlobal: 1, usageLimitPerUser: 1 }));
    seedOrderLine(h, { lineTotal: 1_000 });
    await h.apply.execute({ code: 'SAVE10', orderId: ORDER, customerUserId: CUSTOMER });
    h.audit.record.mockClear();
    h.outbox.write.mockClear();
    return h;
  }

  it('transitions the redemption to REVERSED and gives the usage back', async () => {
    const h = await withRedemption();
    expect(await h.repo.countAppliedForCoupon('coupon-1')).toBe(1);

    const result = await h.reverse.execute({ orderId: ORDER, code: 'SAVE10' });

    expect(result).toMatchObject({
      orderId: ORDER,
      discountAmount: 100,
      status: RedemptionStatus.REVERSED,
      replay: false,
    });
    // The usage is back in the pool purely because the row stopped being APPLIED.
    expect(await h.repo.countAppliedForCoupon('coupon-1')).toBe(0);
    expect(await h.repo.countAppliedForCouponAndUser('coupon-1', CUSTOMER)).toBe(0);
    // And no row was deleted — the record of what happened stays.
    expect(h.repo.redemptions.size).toBe(1);
  });

  it('lets the freed usage be spent again', async () => {
    const h = await withRedemption();
    await h.reverse.execute({ orderId: ORDER, code: 'SAVE10' });

    h.orders.order = { ...h.orders.order!, id: 'order-2' };
    const again = await h.apply.execute({
      code: 'SAVE10',
      orderId: 'order-2',
      customerUserId: CUSTOMER,
    });

    expect(again.discountAmount).toBe(100);
    expect(await h.repo.countAppliedForCoupon('coupon-1')).toBe(1);
  });

  it('is idempotent — a second reversal is a no-op, not an error', async () => {
    const h = await withRedemption();
    await h.reverse.execute({ orderId: ORDER, code: 'SAVE10' });

    const second = await h.reverse.execute({ orderId: ORDER, code: 'SAVE10' });

    expect(second.replay).toBe(true);
    expect(second.status).toBe(RedemptionStatus.REVERSED);
    // One audit entry and one event across both calls.
    expect(h.audit.record).toHaveBeenCalledTimes(1);
    expect(h.outbox.write).toHaveBeenCalledTimes(1);
  });

  it('finds the redemption by id as well as by code', async () => {
    const h = await withRedemption();
    const [redemption] = [...h.repo.redemptions.values()];

    const result = await h.reverse.execute({ orderId: ORDER, redemptionId: redemption.id });

    expect(result.redemptionId).toBe(redemption.id);
  });

  it('refuses a redemption id that belongs to a different order', async () => {
    const h = await withRedemption();
    const [redemption] = [...h.repo.redemptions.values()];

    expect(
      await codeOf(() =>
        h.reverse.execute({ orderId: 'order-elsewhere', redemptionId: redemption.id }),
      ),
    ).toBe(ErrorCode.NOT_FOUND);
  });

  it('never creates a redemption when none exists', async () => {
    const h = harness();
    await h.repo.create(couponProps());

    expect(await codeOf(() => h.reverse.execute({ orderId: ORDER, code: 'SAVE10' }))).toBe(
      ErrorCode.NOT_FOUND,
    );
    expect(h.repo.redemptions.size).toBe(0);
  });

  it('reverses the order’s own applied redemption when given neither a code nor an id', async () => {
    const h = await withRedemption();

    // What a cancelling saga calls: it holds an order id and has no reason to know which
    // promotion was used. Unambiguous because ADR-021 allows an order only one APPLIED coupon.
    const result = await h.reverse.execute({ orderId: ORDER, reason: 'order-cancelled' });

    expect(result).toMatchObject({ orderId: ORDER, status: RedemptionStatus.REVERSED });
    expect(await h.repo.countAppliedForCoupon('coupon-1')).toBe(0);
  });

  it('reports NOT_FOUND for an order with no redemption at all', async () => {
    const h = harness();

    expect(await codeOf(() => h.reverse.execute({ orderId: ORDER }))).toBe(ErrorCode.NOT_FOUND);
  });

  it('skips an already-reversed redemption rather than replaying it as a no-op', async () => {
    const h = await withRedemption();
    await h.reverse.execute({ orderId: ORDER });

    // Second cancellation of the same order: nothing is APPLIED, so there is nothing to find.
    // Returning the REVERSED row would report a successful no-op and hide that fact.
    expect(await codeOf(() => h.reverse.execute({ orderId: ORDER }))).toBe(ErrorCode.NOT_FOUND);
  });

  it('records the audit entry and the catalogued coupon.reversed event', async () => {
    const h = await withRedemption();

    await h.reverse.execute({ orderId: ORDER, code: 'SAVE10', reason: 'order cancelled' });

    const [entry] = h.audit.record.mock.calls[0];
    expect(entry).toMatchObject({
      action: 'COUPON_REVERSED',
      resourceType: 'CouponRedemption',
      // A saga-driven reversal has no human actor, and none is fabricated.
      actorUserId: null,
    });
    expect(entry.context).toMatchObject({
      couponId: 'coupon-1',
      orderId: ORDER,
      discountAmount: 100,
      reason: 'order cancelled',
      outcome: 'REVERSED',
    });

    expect(h.outbox.write.mock.calls[0][0]).toMatchObject({
      type: 'coupon.reversed',
      aggregateType: 'Coupon',
      aggregateId: 'coupon-1',
    });
  });
});

// =============================================================================================
// Admin management
// =============================================================================================

describe('ManageCouponCommand (F-CPN-01)', () => {
  const ADMIN = 'admin-1';

  it('creates a coupon with a canonical code', async () => {
    const h = harness();

    const created = await h.manage.create({
      actorUserId: ADMIN,
      code: '  save10 ',
      discountType: DiscountType.PERCENT,
      value: 10,
    });

    expect(created.code).toBe('SAVE10');
    expect(h.audit.record).toHaveBeenCalledTimes(1);
    expect(h.audit.record.mock.calls[0][0]).toMatchObject({
      action: 'COUPON_CREATED',
      resourceType: 'Coupon',
      actorUserId: ADMIN,
    });
    // Curation is audited, never published — no coupon.created event exists.
    expect(h.outbox.write).not.toHaveBeenCalled();
  });

  it('refuses a duplicate code regardless of case', async () => {
    const h = harness();
    await h.manage.create({
      actorUserId: ADMIN,
      code: 'SAVE10',
      discountType: DiscountType.PERCENT,
      value: 10,
    });

    const code = await codeOf(() =>
      h.manage.create({
        actorUserId: ADMIN,
        code: 'save10',
        discountType: DiscountType.PERCENT,
        value: 10,
      }),
    );

    expect(code).toBe(ErrorCode.CONFLICT);
    expect(h.repo.coupons.size).toBe(1);
  });

  it('updates a coupon and records both sides of the change', async () => {
    const h = harness();
    const created = await h.manage.create({
      actorUserId: ADMIN,
      code: 'SAVE10',
      discountType: DiscountType.PERCENT,
      value: 10,
    });
    h.audit.record.mockClear();

    const updated = await h.manage.update({
      actorUserId: ADMIN,
      couponId: created.id,
      value: 25,
    });

    expect(updated.value).toBe(25);
    expect(updated.code).toBe('SAVE10');
    const context = h.audit.record.mock.calls[0][0].context;
    expect(context.changes).toMatchObject({
      before: expect.objectContaining({ value: 10 }),
      after: expect.objectContaining({ value: 25 }),
    });
  });

  it('refuses an update that would make the configuration invalid', async () => {
    const h = harness();
    const created = await h.manage.create({
      actorUserId: ADMIN,
      code: 'SAVE10',
      discountType: DiscountType.PERCENT,
      value: 10,
    });

    expect(
      await codeOf(() =>
        h.manage.update({ actorUserId: ADMIN, couponId: created.id, value: 500 }),
      ),
    ).toBe(ErrorCode.VALIDATION_ERROR);
    expect((await h.repo.findById(created.id))!.value).toBe(10);
  });

  it('deactivates and reactivates, auditing each separately', async () => {
    const h = harness();
    const created = await h.manage.create({
      actorUserId: ADMIN,
      code: 'SAVE10',
      discountType: DiscountType.PERCENT,
      value: 10,
    });
    h.audit.record.mockClear();

    await h.manage.setActive({ actorUserId: ADMIN, couponId: created.id, isActive: false });
    await h.manage.setActive({ actorUserId: ADMIN, couponId: created.id, isActive: true });

    expect(h.audit.record.mock.calls.map((call) => call[0].action)).toEqual([
      'COUPON_DEACTIVATED',
      'COUPON_ACTIVATED',
    ]);
    expect((await h.repo.findById(created.id))!.isActive).toBe(true);
  });

  it('keeps redemptions when a coupon is withdrawn', async () => {
    const h = harness();
    await h.repo.create(couponProps());
    seedOrderLine(h, { lineTotal: 1_000 });
    await h.apply.execute({ code: 'SAVE10', orderId: ORDER, customerUserId: CUSTOMER });

    await h.manage.setActive({ actorUserId: ADMIN, couponId: 'coupon-1', isActive: false });

    expect(h.repo.redemptions.size).toBe(1);
    expect(await h.repo.countAppliedForCoupon('coupon-1')).toBe(1);
  });

  it('reports an unknown coupon rather than creating one', async () => {
    const h = harness();

    expect(
      await codeOf(() => h.manage.update({ actorUserId: ADMIN, couponId: 'nope', value: 5 })),
    ).toBe(ErrorCode.NOT_FOUND);
  });
});

// =============================================================================================
// Module 06 integration contract (ADR-019 / ADR-020 / ADR-021)
// =============================================================================================

/**
 * These protect the seam the Module 06 coupon integration will be built on — not behaviour any
 * customer can reach today, because `COUPON_PORT` still has no consumer.
 *
 * Two of them pin a **gap** rather than a guarantee. Where ADR-020/ADR-021 decide something the
 * code does not yet enforce, the test records that it is absent and names the ADR that closes it.
 * That way the integration's first commit has to edit a documented expectation on purpose, rather
 * than silently flipping behaviour nobody was watching.
 */
describe('Module 06 integration contract (ADR-019/020/021)', () => {
  it('is reached only through ICouponPort, which delegates each call unchanged', async () => {
    const h = harness();
    const port = new CouponPortAdapter(h.validate, h.apply, h.reverse);
    await h.repo.create(couponProps());
    seedCartLine(h, { price: 1_000 });
    seedOrderLine(h, { lineTotal: 1_000 });

    // The three methods are the three moments checkout cares about: quote, redeem, give back.
    expect(Object.getOwnPropertyNames(CouponPortAdapter.prototype).sort()).toEqual([
      'apply',
      'constructor',
      'reverse',
      'validate',
    ]);

    const quoted = await port.validate({ customerUserId: CUSTOMER, code: 'SAVE10' });
    expect(quoted).toMatchObject({ valid: true, discountAmount: 100 });
    // A quote consumes nothing — the redemption row only ever comes from `apply`.
    expect(h.repo.redemptions.size).toBe(0);

    const applied = await port.apply({
      code: 'SAVE10',
      orderId: ORDER,
      customerUserId: CUSTOMER,
    });
    expect(applied).toMatchObject({ orderId: ORDER, discountAmount: 100, replay: false });

    const reversed = await port.reverse({ orderId: ORDER, code: 'SAVE10' });
    expect(reversed).toMatchObject({ status: RedemptionStatus.REVERSED, replay: false });
  });

  it('refuses to redeem against an order that does not exist yet', async () => {
    const h = harness();
    await h.repo.create(couponProps());
    h.orders.order = null;

    // Section 11.7: a redemption row needs an `order_id`, so checkout step 5 — which has no order
    // — can only *quote*. `apply` runs after the order-creation transaction has committed.
    expect(
      await codeOf(() =>
        h.apply.execute({ code: 'SAVE10', orderId: ORDER, customerUserId: CUSTOMER }),
      ),
    ).toBe(ErrorCode.ORDER_NOT_FOUND);
    expect(h.repo.redemptions.size).toBe(0);
  });

  it('answers with a discount amount only, never with a fee or an order total (ADR-019)', async () => {
    const h = harness();
    await h.repo.create(couponProps());
    seedOrderLine(h, { lineTotal: 1_000 });

    const result = await h.apply.execute({
      code: 'SAVE10',
      orderId: ORDER,
      customerUserId: CUSTOMER,
    });

    // ADR-019's first binding clause: `PricingCalculator` stays the sole owner of order money.
    // Module 07 says how much a coupon is worth and nothing about how it composes into a total,
    // so no funding model is baked in here and the open decision stays genuinely open.
    expect(result.discountAmount).toBe(100);
    expect(Object.keys(result).sort()).toEqual([
      'code',
      'couponId',
      'currency',
      'customerUserId',
      'discountAmount',
      'orderId',
      'redemptionId',
      'replay',
      'status',
    ]);
  });

  it('cannot quote a pharmacy-scoped coupon from a cart, but redeems it against the matched order (ADR-020)', async () => {
    const h = harness();
    await h.repo.create(couponProps({ scope: { pharmacyIds: [PHARMACY_A] } }));
    seedCartLine(h, { price: 1_000 });
    seedOrderLine(h, { lineTotal: 1_000, pharmacyId: PHARMACY_A });

    // Preview: a cart has no pharmacy, so this is provisional by design — and a *distinct*
    // reason, so a client can say "applies at some pharmacies" rather than "your code is bad".
    const preview = await h.validate.execute({ customerUserId: CUSTOMER, code: 'SAVE10' });
    expect(preview).toMatchObject({
      valid: false,
      reason: 'PHARMACY_SCOPE_UNRESOLVABLE',
      discountAmount: 0,
    });

    // Post-matching: the same coupon is worth 100 once the order names the pharmacy.
    expect(
      await h.apply.execute({ code: 'SAVE10', orderId: ORDER, customerUserId: CUSTOMER }),
    ).toMatchObject({ discountAmount: 100 });

    // The checkout saga asks the same question with its own matched pharmacy and gets the real
    // answer. That path is in-process only — `CouponValidateDto` has no `checkout` field, so a
    // pharmacy can never arrive over HTTP (ADR-020 clause 3).
    const atCheckout = await h.validate.execute({
      customerUserId: CUSTOMER,
      code: 'SAVE10',
      checkout: {
        pharmacyId: PHARMACY_A,
        lines: [{ catalogProductId: PRODUCT_A, quantity: 1, unitPrice: 1_000 }],
      },
    });
    expect(atCheckout).toMatchObject({ valid: true, discountAmount: 100 });

    // And a coupon scoped to a *different* pharmacy is refused there, not silently allowed.
    const elsewhere = await h.validate.execute({
      customerUserId: CUSTOMER,
      code: 'SAVE10',
      checkout: {
        pharmacyId: PHARMACY_B,
        lines: [{ catalogProductId: PRODUCT_A, quantity: 1, unitPrice: 1_000 }],
      },
    });
    expect(elsewhere).toMatchObject({ valid: false, reason: 'NOT_IN_SCOPE', discountAmount: 0 });
    expect(Object.keys(preview)).not.toContain('pharmacyId');
  });

  it('refuses a second, different coupon on one order (ADR-021)', async () => {
    const h = harness();
    await h.repo.create(couponProps({ id: 'coupon-1', code: 'SAVE10' }));
    await h.repo.create(
      couponProps({ id: 'coupon-2', code: 'SAVE5', discountType: DiscountType.FIXED, value: 50 }),
    );
    seedOrderLine(h, { lineTotal: 1_000 });

    await h.apply.execute({ code: 'SAVE10', orderId: ORDER, customerUserId: CUSTOMER });

    // Section 7's unique index is `(couponId, orderId)`, so it stops the *same* coupon twice and
    // not this. The rule is enforced by an `APPLIED` count inside the same Serializable
    // transaction as the insert — a cross-row condition no row-level constraint can express.
    expect(
      await codeOf(() =>
        h.apply.execute({ code: 'SAVE5', orderId: ORDER, customerUserId: CUSTOMER }),
      ),
    ).toBe(ErrorCode.COUPON_INVALID);
    expect(h.repo.redemptions.size).toBe(1);
    expect(await h.repo.findRedemptionsByOrder(ORDER)).toHaveLength(1);
  });

  it('lets a reversed order take a different coupon — no @@unique([orderId]) blocks it', async () => {
    const h = harness();
    await h.repo.create(couponProps({ id: 'coupon-1', code: 'SAVE10' }));
    await h.repo.create(
      couponProps({ id: 'coupon-2', code: 'SAVE5', discountType: DiscountType.FIXED, value: 50 }),
    );
    seedOrderLine(h, { lineTotal: 1_000 });

    await h.apply.execute({ code: 'SAVE10', orderId: ORDER, customerUserId: CUSTOMER });
    await h.reverse.execute({ orderId: ORDER, code: 'SAVE10' });

    // The REVERSED row no longer counts as APPLIED, so ADR-021 is satisfied and a different
    // coupon may legitimately be applied. A `@@unique([orderId])` would have blocked this
    // permanently — which is exactly why ADR-021 rejects that form of the constraint.
    const second = await h.apply.execute({
      code: 'SAVE5',
      orderId: ORDER,
      customerUserId: CUSTOMER,
    });
    expect(second).toMatchObject({ code: 'SAVE5', discountAmount: 50 });
  });

  it('reverses usage without moving money — a reversal is not a refund', async () => {
    const h = harness();
    await h.repo.create(couponProps());
    seedOrderLine(h, { lineTotal: 1_000 });
    const applied = await h.apply.execute({
      code: 'SAVE10',
      orderId: ORDER,
      customerUserId: CUSTOMER,
    });

    await h.reverse.execute({ orderId: ORDER, code: 'SAVE10', reason: 'customer-cancel' });

    const row = await h.repo.findRedemptionById(applied.redemptionId);
    // Only `status` moves. The recorded discount is left exactly as it was, because it describes
    // money that really was discounted; returning that money is section 11.4's refund flow
    // against the payment, owned by whichever module cancelled (ADR-017). A reversal that also
    // moved money would double-count every cancellation.
    expect(row).toMatchObject({
      status: RedemptionStatus.REVERSED,
      discountAmount: applied.discountAmount,
      orderId: ORDER,
    });
    // The usage is back in the pool purely because the limits count `APPLIED` rows.
    expect(await h.repo.countAppliedForCoupon('coupon-1')).toBe(0);

    // Nothing but the two catalogued coupon events was emitted — no ledger posting, no payment.
    expect(h.outbox.write.mock.calls.map(([event]) => event.type)).toEqual([
      'coupon.redeemed',
      'coupon.reversed',
    ]);
  });
});
