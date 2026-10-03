import tseslint from 'typescript-eslint';
export default tseslint.config({ ignores: ['dist/**','node_modules/**'] }, ...tseslint.configs.recommended, {files:['engine/**/*.mjs'],rules:{'@typescript-eslint/no-unused-vars':['error',{args:'none',caughtErrors:'none'}]}});
