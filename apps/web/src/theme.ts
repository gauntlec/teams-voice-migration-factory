import { createLightTheme, createDarkTheme, type BrandVariants, type Theme } from '@fluentui/react-components';

/**
 * Brand ramp approximating the Microsoft Teams Admin Center purple so the tool
 * feels familiar to Teams admins. Tweak in one place.
 */
const brand: BrandVariants = {
  10: '#020306',
  20: '#111528',
  30: '#16204B',
  40: '#1B2A67',
  50: '#213485',
  60: '#293FA3',
  70: '#354BC0',
  80: '#4657D2',
  90: '#5B5FC7',
  100: '#6E73D6',
  110: '#8388E0',
  120: '#989DE9',
  130: '#ADB2F0',
  140: '#C3C7F6',
  150: '#DADCFA',
  160: '#EEEFFD',
};

export const lightTheme: Theme = { ...createLightTheme(brand) };
export const darkTheme: Theme = { ...createDarkTheme(brand) };
