export const maxRepositoryPathLength = 2000;

export function isRepositoryPath(path: string): boolean {
  return Array.from(path).length <= maxRepositoryPathLength
    && !/[\p{Cc}\p{Cs}\p{Bidi_Control}\\:]/u.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
