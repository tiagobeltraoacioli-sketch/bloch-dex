import { createContext } from 'react';

/** The lamp key of the network the shell is on (styles/tokens.css): token marks take their badge from it. */
export const NetworkKeyContext = createContext<string>('bloch-l2');
