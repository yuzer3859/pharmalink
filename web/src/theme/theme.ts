import { createTheme, alpha } from '@mui/material/styles';

const BRAND = {
  primary: '#00838f',
  primaryDark: '#005662',
  secondary: '#7b1fa2',
  success: '#2e7d32',
  warning: '#ed6c02',
  error: '#d32f2f',
  info: '#0277bd',
};

export const buildTheme = (mode: 'light' | 'dark') =>
  createTheme({
    palette: {
      mode,
      primary: { main: BRAND.primary, dark: BRAND.primaryDark, contrastText: '#fff' },
      secondary: { main: BRAND.secondary },
      success: { main: BRAND.success },
      warning: { main: BRAND.warning },
      error: { main: BRAND.error },
      info: { main: BRAND.info },
      background:
        mode === 'light'
          ? { default: '#f4f6f8', paper: '#ffffff' }
          : { default: '#0b1418', paper: '#111d22' },
    },
    shape: { borderRadius: 10 },
    typography: {
      fontFamily: ['Inter', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'].join(','),
      h4: { fontWeight: 700, letterSpacing: -0.5 },
      h5: { fontWeight: 700 },
      h6: { fontWeight: 700 },
      subtitle2: { fontWeight: 600 },
      button: { fontWeight: 600, textTransform: 'none' },
    },
    components: {
      MuiCard: {
        styleOverrides: {
          root: {
            borderRadius: 14,
            border: `1px solid ${alpha('#94a3b8', 0.18)}`,
            boxShadow:
              mode === 'light'
                ? '0 1px 2px rgba(16,24,40,0.06), 0 1px 3px rgba(16,24,40,0.04)'
                : 'none',
          },
        },
      },
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiPaper: { defaultProps: { elevation: 0 } },
      MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
      MuiTableCell: { styleOverrides: { head: { fontWeight: 700 } } },
    },
  });
