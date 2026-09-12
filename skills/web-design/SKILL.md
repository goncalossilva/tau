---
name: web-design
description: "Design and implement distinctive, production-ready web interfaces with strong aesthetic direction. Use when asked to create or restyle web pages, components, or applications (HTML/CSS/JS, React, Vue, etc.)."
---

# Web Design

Deliver real, working interfaces with purposeful visual choices, not just mockups or mood boards. Distinctive aesthetics are the default for open-ended design. Scoped changes should fit the existing product rather than impose a redesign.

## Workflow

1. **Understand the brief and scope.** Identify purpose, audience, required content and behavior, technical constraints, and any brand or accessibility requirements from the request and existing code. Clarify missing requirements when they materially affect the result. Resolve routine choices from context and state important assumptions without a question quota.
2. **Choose a coherent direction.** For a new design or open-ended restyle, commit to a memorable aesthetic suited to the brief, such as editorial, industrial, refined minimalism, or organic texture. Let typography, palette, composition, and detail reinforce it rather than assembling stock layouts. For a scoped edit, preserve the existing design system, tokens, fonts, components, and interaction conventions unless the user requests a change.
3. **Implement within the project.** Reuse the established stack and components. Build the requested behavior, content, and relevant loading, empty, error, and success states. Make styling easy to maintain through the project's tokens or CSS variables. Supply usable assets such as inline SVG or CSS artwork when needed, not broken placeholders.
4. **Verify and finish.** Check the working result at relevant viewport sizes and interaction states. Verify keyboard use, focus, legibility, and reduced-motion behavior. Fix problems within scope and report changed files, meaningful design decisions, verification, and any remaining gaps. If delivering standalone code, include complete runnable files and necessary setup. For code-only requests, omit the design narration.

## Design standards

- **Intentional typography.** Establish a clear hierarchy through size, weight, spacing, and casing. For open-ended work, choose expressive type rather than defaulting to generic font choices. Pair display and body faces when useful, not as a requirement. Existing product fonts remain appropriate for scoped changes.
- **Cohesive color and composition.** Use a purposeful palette with readable contrast. Create rhythm with spacing, alignment, scale, and deliberate negative space or density. Asymmetry, grid breaks, texture, borders, and depth should serve the concept, not become decoration for its own sake.
- **Distinctiveness without novelty for its own sake.** Avoid interchangeable hero-and-card compositions or fashionable gradients as an automatic answer to an open brief. A restrained layout or familiar component can be right when it serves the content and product.
- **Semantic, accessible behavior.** Use meaningful headings and landmarks, labeled controls, visible focus, keyboard navigation, and sufficient contrast. Preserve usability across interaction states, not just in a static screenshot.
- **Responsive implementation.** Use fluid layouts, appropriate breakpoints and typography, and robust Grid/Flex composition instead of brittle positioning. Check overflow and content variation on small and large screens.
- **Purposeful motion.** Use animation only when it helps communicate hierarchy, state, or feedback. Prefer a coherent interaction over many distracting effects, honor `prefers-reduced-motion`, and keep essential information available without animation.

Keep the explanation proportional to the task. A small component adjustment does not need a named aesthetic or a separate design-system ceremony, but it still needs working behavior and visual care.
