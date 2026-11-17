import { PrescriptionStatus } from '../../../domain/enums';
import { IPrescriptionRepository } from '../../../domain/repositories/prescription.repository';
import { ApprovePrescriptionCommand } from '../../commands/approve-prescription.command';
import { AssignVerifyingPharmacyCommand } from '../../commands/assign-verifying-pharmacy.command';
import { RejectPrescriptionCommand } from '../../commands/reject-prescription.command';
import { PrescriptionReviewRoutingAdapter } from './prescription-review-routing.adapter';

const rx = (over: Record<string, unknown> = {}) => ({
  id: 'rx-1',
  customerUserId: 'customer-1',
  status: PrescriptionStatus.UPLOADED,
  verifyingPharmacyId: null,
  ...over,
});

function build() {
  const prescriptions = {
    findById: jest.fn().mockResolvedValue(rx()),
    findLinesByPrescriptionId: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<IPrescriptionRepository>;
  const assign = { execute: jest.fn() } as unknown as jest.Mocked<AssignVerifyingPharmacyCommand>;
  const approve = { execute: jest.fn() } as unknown as jest.Mocked<ApprovePrescriptionCommand>;
  const reject = { execute: jest.fn() } as unknown as jest.Mocked<RejectPrescriptionCommand>;
  return { adapter: new PrescriptionReviewRoutingAdapter(prescriptions, assign, approve, reject, {} as never), prescriptions, assign, approve, reject };
}

describe('PrescriptionReviewRoutingAdapter (Work 129: the prescription travels with the order)', () => {
  describe('attaching', () => {
    it("sends the customer's uploaded prescription to the filling pharmacy with what the order asks for", async () => {
      const { adapter, assign } = build();
      const requestedItems = [{ catalogProductId: 'p-1', productName: 'Amoxicillin', quantity: 2 }];

      await adapter.attachToOrder({ customerUserId: 'customer-1', prescriptionId: 'rx-1', verifyingOrganizationId: 'org-1', requestedItems });

      expect(assign.execute).toHaveBeenCalledWith({ prescriptionId: 'rx-1', pharmacyId: 'org-1', requestedItems });
    });

    it("refuses another customer's prescription as not found", async () => {
      const { adapter, prescriptions } = build();
      prescriptions.findById.mockResolvedValue(rx({ customerUserId: 'someone-else' }) as never);

      await expect(adapter.assertAttachable({ customerUserId: 'customer-1', prescriptionId: 'rx-1' })).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });
    });

    it('refuses a prescription already sent to a pharmacy: one prescription, one order', async () => {
      const { adapter, prescriptions, assign } = build();
      prescriptions.findById.mockResolvedValue(rx({ status: PrescriptionStatus.PENDING_VERIFICATION, verifyingPharmacyId: 'org-9' }) as never);

      await expect(
        adapter.attachToOrder({ customerUserId: 'customer-1', prescriptionId: 'rx-1', verifyingOrganizationId: 'org-1', requestedItems: [] }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(assign.execute).not.toHaveBeenCalled();
    });
  });

  describe('the pharmacist decides on the order', () => {
    it('approves one line per ordered product for the ordered quantity, and returns the line for each product', async () => {
      const { adapter, approve, prescriptions } = build();
      prescriptions.findById.mockResolvedValue(rx({ status: PrescriptionStatus.PENDING_VERIFICATION }) as never);
      prescriptions.findLinesByPrescriptionId.mockResolvedValue([{ id: 'pl-1', catalogProductId: 'p-1' }] as never);

      const lines = await adapter.approveForOrder({
        prescriptionId: 'rx-1',
        reviewerUserId: 'pharmacist-1',
        items: [{ catalogProductId: 'p-1', quantity: 3 }],
        legibilityOk: true,
        validityOk: true,
      });

      expect(approve.execute).toHaveBeenCalledWith({
        prescriptionId: 'rx-1',
        reviewerUserId: 'pharmacist-1',
        lines: [{ catalogProductId: 'p-1', approvedQuantity: 3, refillsAllowed: 0, isSingleUse: false }],
        legibilityOk: true,
        validityOk: true,
      });
      expect(lines).toEqual([{ catalogProductId: 'p-1', prescriptionLineId: 'pl-1' }]);
    });

    it('an approval retried after a crash returns the lines already approved', async () => {
      const { adapter, approve, prescriptions } = build();
      prescriptions.findById.mockResolvedValue(rx({ status: PrescriptionStatus.APPROVED }) as never);
      prescriptions.findLinesByPrescriptionId.mockResolvedValue([{ id: 'pl-1', catalogProductId: 'p-1' }] as never);

      const lines = await adapter.approveForOrder({ prescriptionId: 'rx-1', reviewerUserId: 'pharmacist-1', items: [{ catalogProductId: 'p-1', quantity: 3 }], legibilityOk: true, validityOk: true });

      expect(approve.execute).not.toHaveBeenCalled();
      expect(lines).toEqual([{ catalogProductId: 'p-1', prescriptionLineId: 'pl-1' }]);
    });

    it('rejects through the reject command, and a second rejection changes nothing', async () => {
      const { adapter, reject, prescriptions } = build();
      prescriptions.findById.mockResolvedValueOnce(rx({ status: PrescriptionStatus.PENDING_VERIFICATION }) as never);
      await adapter.rejectForOrder({ prescriptionId: 'rx-1', reviewerUserId: 'pharmacist-1', reason: 'Not legible' });
      expect(reject.execute).toHaveBeenCalledWith({ prescriptionId: 'rx-1', reviewerUserId: 'pharmacist-1', reason: 'Not legible' });

      prescriptions.findById.mockResolvedValueOnce(rx({ status: PrescriptionStatus.REJECTED }) as never);
      await adapter.rejectForOrder({ prescriptionId: 'rx-1', reviewerUserId: 'pharmacist-1', reason: 'Not legible' });
      expect(reject.execute).toHaveBeenCalledTimes(1);
    });
  });
});
