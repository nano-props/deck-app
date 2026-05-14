import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Standard shadcn-style className helper: clsx + tailwind-merge so the
 *  later class wins when two utilities target the same property. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
