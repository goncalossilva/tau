---
name: git-clean-history
description: "Reimplement the current Git branch on a fresh branch off `main` with a clean, narrative-quality commit history."
---

# Git Rebase

Use this skill to reimplement the current branch on a new branch with a clean, narrative-quality git commit history suitable for reviewer comprehension.

## Steps

1. **Validate the source branch**
   - Ensure no uncommitted changes or merge conflicts
   - Confirm it is up to date with `main`
   - Confirm `main` is up to date with `origin/main`

2. **Analyze the diff**
   - Study all changes between source branch and `main`
   - Form a clear understanding of the final intended state

3. **Create the clean branch**
   - Create a new branch off of `main` using the new branch name
   - Use the `{source_branch}-clean` name unless another name is provided by the user

4. **Plan the commit storyline**
   - Break the implementation into self-contained logical steps
   - Each step should reflect a stage of development, as if writing a tutorial

5. **Reimplement the work**
   - Recreate changes in the clean branch, committing step by step
   - Each commit must:
     - Introduce a single coherent idea
     - Include a clear commit message and description
     - Follow best practices for the message as outlined by the `git-commit` skill
   - **Use `git commit --no-verify` for all intermediate commits**
     - Pre-commit hooks check tests, types, and imports that may not pass until the full implementation is complete; do not waste time fixing issues in intermediate commits that will be resolved by later commits

6. **Verify correctness**
   - Confirm the final state exactly matches the source branch
   - Run the final commit **without** `--no-verify` to ensure all checks pass

### Rules

- Do not add yourself as an author or contributor
- Do not include "Generated with ...", "Co-Authored-By: ...", or any AI attribution
- The end state of the clean branch must be identical to the source branch
