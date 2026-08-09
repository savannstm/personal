import perfectionist from "eslint-plugin-perfectionist";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig({
    extends: [
        tseslint.configs.strictTypeChecked,
        tseslint.configs.stylisticTypeChecked,
        perfectionist.configs["recommended-alphabetical"],
    ],
    files: ["**/*.ts"],
    languageOptions: {
        parserOptions: {
            ecmaFeatures: {
                impliedStrict: true,
            },
            projectService: true,
            sourceType: "module",
            tsconfigRootDir: import.meta.dirname,
        },
    },
    rules: {
        "@typescript-eslint/consistent-type-imports": "error",
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-floating-promises": "error",
        "@typescript-eslint/no-misused-promises": "error",
        "@typescript-eslint/no-non-null-assertion": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/restrict-template-expressions": "off",
        curly: "error",
        "perfectionist/sort-exports": "off",
        "perfectionist/sort-interfaces": "off",
        "perfectionist/sort-modules": "off",
        "perfectionist/sort-variable-declarations": "off",
    },
});
