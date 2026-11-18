import { Link as RouterLink } from 'react-router-dom';
import { Alert, Button } from '@mui/material';
import MedicationRoundedIcon from '@mui/icons-material/MedicationRounded';
import { rxRequestAlertText } from '@/services/pharmacyRxRequests.service';

/**
 * Work 140: the banner on every pharmacy portal page while a prescription request waits for the
 * pharmacy, so a pharmacist on Orders or the dashboard still sees it arrive.
 */
export function RxRequestAlert({ toAnswer, toQuote, to }: { toAnswer: number; toQuote: number; to: string }) {
  const text = rxRequestAlertText({ toAnswer, toQuote });
  if (!text) return null;
  return (
    <Alert
      severity="warning"
      icon={<MedicationRoundedIcon />}
      role="status"
      aria-live="polite"
      sx={{ mb: 2, alignItems: 'center' }}
      action={
        <Button component={RouterLink} to={to} color="inherit" variant="outlined" size="small">
          Open
        </Button>
      }
    >
      {text}
    </Alert>
  );
}
