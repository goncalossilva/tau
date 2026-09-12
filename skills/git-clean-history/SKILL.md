---
name: git-clean-history
description: "Rebuild the current branch from `main` on a fresh branch with a clean, narrative commit history."
---

# Git Clean History

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
     - Follow the repository's commit-message conventions
   - **Use `git commit --no-verify` for all intermediate commits while cleaning history.**
     - Pre-commit hooks check tests, types, and imports that may not pass until the full implementation is complete. Do not spend time fixing intermediate issues that later commits in the reconstruction will resolve.

6. **Verify correctness**
   - Confirm the final state exactly matches the source branch
   - Run the final commit **without** `--no-verify`, and ensure the repository's required checks pass

### Rules

- Do not add yourself as an author or contributor
- Do not include "Generated with ...", "Co-Authored-By: ...", or any AI attribution
- The end state of the clean branch must be identical to the source branch
