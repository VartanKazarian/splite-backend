const config = require('../config');
const { logger } = require('../connectors/logger');
const providers = require('./providers');

/**
 * Registra los adaptadores fiscales que este despliegue tenga configurados.
 *
 * Se llama una vez al arrancar y no bajo demanda: un adaptador a medio escribir
 * tiene que impedir arrancar -- `register` lo comprueba -- en vez de fallar
 * delante de un comensal que espera su factura.
 *
 * Sin configuración no se registra nada, y eso es lo correcto. `adapterFor`
 * reventará con FISCAL_PROVIDER_UNKNOWN si alguien intenta emitir, que es mucho
 * mejor que caer en un simulado y producir un documento de mentira con toda la
 * apariencia de bueno.
 */
function registerFiscalProviders() {
  if (config.fiscal.mockEnabled) {
    // Sólo fuera de producción: `assertProductionConfig` rechaza esta bandera
    // en producción, de modo que llegar aquí con ella puesta ya es imposible.
    const { createMockProvider } = require('./providers/mock');
    providers.register('mock', createMockProvider());
    logger.warn({
      event: 'FISCAL_MOCK_REGISTERED'
    }, 'Proveedor fiscal simulado activo: los documentos que emita NO son facturas fiscales');
  }

  if (config.fiscal.provider && config.fiscal.provider !== 'mock') {
    // Aquí irá la imprenta digital autorizada cuando haya contrato con una. No
    // hay un adaptador genérico que valga: cada imprenta tiene su protocolo, y
    // fingir uno produciría exactamente el documento falso que este módulo
    // existe para evitar.
    logger.error({
      event: 'FISCAL_PROVIDER_NOT_IMPLEMENTED', provider: config.fiscal.provider
    }, 'FISCAL_PROVIDER nombra un proveedor sin adaptador: no se podrá emitir');
  }
}

module.exports = { registerFiscalProviders };
