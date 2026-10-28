import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import {
  listTemplatesAny,
  getTemplateAny,
  saveTemplate,
  summarize,
  templateExists,
  validateYaml,
} from '../templates/store.js';

interface CreateTemplateBody {
  name: string;
  yaml_content: string;
}

export async function templatesRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/templates - list all templates (name, description, model, variables only)
  app.get('/templates', async (_request: FastifyRequest, _reply: FastifyReply) => {
    const templates = listTemplatesAny().map(summarize);
    return {
      templates: templates.map((t) => ({
        name: t.name,
        description: t.description,
        model: t.model,
        variables: t.variables,
        version: t.version,
      })),
    };
  });

  // GET /v1/templates/:name - return full template including prompts
  app.get(
    '/templates/:name',
    async (request: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
      const { name } = request.params;
      const template = getTemplateAny(name);

      if (!template) {
        reply.code(404).send({ error: `Template '${name}' not found` });
        return;
      }

      return template.t;
    }
  );

  // POST /v1/templates - create or update a template
  app.post(
    '/templates',
    async (
      request: FastifyRequest<{ Body: CreateTemplateBody }>,
      reply: FastifyReply
    ) => {
      const body = request.body as CreateTemplateBody;

      if (!body || typeof body !== 'object') {
        reply.code(400).send({ error: 'Request body must be a JSON object' });
        return;
      }

      const { name, yaml_content } = body;

      if (!name || typeof name !== 'string' || name.trim() === '') {
        reply.code(400).send({ error: 'Field "name" is required and must be a non-empty string' });
        return;
      }

      if (!yaml_content || typeof yaml_content !== 'string' || yaml_content.trim() === '') {
        reply.code(400).send({
          error: 'Field "yaml_content" is required and must be a non-empty string',
        });
        return;
      }

      // Validate YAML is parseable and has required fields
      let parsed;
      try {
        parsed = validateYaml(yaml_content);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        reply.code(400).send({ error: msg });
        return;
      }

      const existed = templateExists(name);

      try {
        saveTemplate(name, yaml_content);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        reply.code(500).send({ error: `Failed to save template: ${msg}` });
        return;
      }

      return {
        success: true,
        name,
        created: !existed,
        template: {
          name: parsed.name,
          description: parsed.description,
          model: parsed.model,
          variables: parsed.variables,
        },
      };
    }
  );
}
