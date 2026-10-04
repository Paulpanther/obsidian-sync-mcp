// Minimal typings for the parts of diff-match-patch this project uses
// (the package ships none and @types/diff-match-patch is not a dependency).
declare module "diff-match-patch" {
    export type Diff = [number, string];
    export const DIFF_DELETE: -1;
    export const DIFF_INSERT: 1;
    export const DIFF_EQUAL: 0;
    export class diff_match_patch {
        diff_main(text1: string, text2: string, checklines?: boolean): Diff[];
        diff_linesToChars_(text1: string, text2: string): { chars1: string; chars2: string; lineArray: string[] };
        diff_charsToLines_(diffs: Diff[], lineArray: string[]): void;
        [key: string]: any;
    }
}
