---
name: web-design
description: "Design and implement distinctive, production-ready web interfaces with strong aesthetic direction. Use when asked to create or restyle web pages, components, or applications (HTML/CSS/JS, React, Vue, etc.)."
---

# Web Design

When implementing, deliver real, working interfaces with purposeful visual choices, not just mockups or mood boards. Distinctive aesthetics are the default for open-ended design. Scoped changes should fit the existing product rather than impose a redesign.

## Workflow

1. **Understand the brief and scope.** Identify purpose, audience, required content and behavior, technical constraints, and any brand or accessibility requirements from the request and existing code. Clarify missing requirements when they materially affect the result. Resolve routine choices from context and state important assumptions.
2. **Choose a coherent direction.** When the visual direction is open, explore contrasting concepts grounded in the brief, the user's taste, and concrete visual references. Vary composition and interaction, not just color. Use available feedback to refine the direction, then commit to a coherent, memorable aesthetic. For a scoped edit, preserve the existing design system, tokens, fonts, components, and interaction conventions unless the user requests a change.

   When exploring alternative designs for early user direction, generate a fresh random alphanumeric string with a shell command for each option. Use patterns in the seed to inspire typography, palette, composition, or interaction. Keep the seed out of the UI and product copy.

3. **Implement within the project.** Reuse the established stack and components. Build the requested behavior, content, and relevant loading, empty, error, and success states. Make styling easy to maintain through the project's tokens or CSS variables. Choose photography, illustration, SVG, or CSS artwork to serve the content and direction. Reuse suitable project or user-provided assets, and use image generation when appropriate tools are available and authorized. Deliver usable assets, not broken placeholders.
4. **Critique and refine.** Inspect the rendered result, not just the code. For substantial visual work, use an independent reviewer in a fresh context when available. Provide the brief, constraints, current screenshots, and visual references—not code, prior critiques, or implementation rationale. Ask for specific, prioritized improvements to hierarchy, composition, clarity, and detail. Remove redundant copy, containers, and decoration that weaken the task or aesthetic, while preserving essential information and usable controls.
5. **Verify and finish.** Check the working result at relevant viewport sizes and interaction states. Verify keyboard use, focus, legibility, and reduced-motion behavior. Fix problems within scope. Keep the explanation proportional to the task, covering changed files, meaningful design decisions, verification, and remaining gaps. State when visual verification was unavailable. If delivering standalone code, include complete runnable files and necessary setup. For code-only requests, omit the design narration.

## Design standards

- **Intentional typography.** Establish a clear hierarchy through size, weight, spacing, and casing. For open-ended work, choose expressive type rather than defaulting to generic font choices. Pair display and body faces when useful.
- **Cohesive color and composition.** Use a purposeful palette with readable contrast. Create rhythm with spacing, alignment, scale, and deliberate negative space or density. Asymmetry, grid breaks, texture, borders, and depth should serve the concept, not become decoration for its own sake.
- **Distinctiveness without novelty for its own sake.** Avoid interchangeable hero-and-card compositions or fashionable gradients as an automatic answer to an open brief. A restrained layout or familiar component can be right when it serves the content and product.
- **Semantic, accessible behavior.** Use meaningful headings and landmarks, labeled controls, visible focus, keyboard navigation, and sufficient contrast. Preserve usability across interaction states, not just in a static screenshot.
- **Responsive implementation.** Use fluid layouts, appropriate breakpoints and typography, and robust Grid/Flex composition instead of brittle positioning. Check overflow and content variation on small and large screens.
- **Purposeful motion.** Use restrained animation to support interactions or the visual direction. Avoid distracting loops and competing effects. Honor `prefers-reduced-motion`, and keep essential information available without animation.
