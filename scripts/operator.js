#!/usr/bin/env node

const db = require('../src/connectors/base');
const operators = require('../src/services/operators');

/**
 * Las personas de Splite que entran a la consola (/admin).
 *
 *   npm run operator -- list
 *   npm run operator -- create <correo> <ADMIN|SUPPORT> <nombre...>
 *   npm run operator -- reset <correo>       (teléfono perdido: contraseña y autenticador nuevos)
 *   npm run operator -- disable <correo>
 *   npm run operator -- enable <correo>
 *
 * Crear y rehacer operadores es sólo de aquí, a propósito: la consola no puede
 * crear cuentas de consola, así que una sesión robada no se fabrica otra.
 *
 * `create` y `reset` imprimen un enlace de un solo uso que caduca en
 * 72 horas. Es una credencial: dáselo a la persona por un canal privado, no lo
 * pegues en un grupo ni en un ticket. Al abrirlo elige su contraseña y vincula
 * su autenticador (Google Authenticator, 1Password...).
 */

function usage() {
  console.log([
    'Uso:',
    '  npm run operator -- list',
    '  npm run operator -- create <correo> <ADMIN|SUPPORT> <nombre...>',
    '  npm run operator -- reset <correo>',
    '  npm run operator -- disable <correo>',
    '  npm run operator -- enable <correo>'
  ].join('\n'));
  process.exitCode = 1;
}

function printLink(token) {
  console.log('\nEnlace de alta (un solo uso, caduca en 72 h). Es una credencial: envíalo por un canal privado.\n');
  console.log(`  ${operators.setupLink(token)}\n`);
}

async function run() {
  const [command, email, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'list': {
      const all = await operators.listOperators();
      if (!all.length) return console.log('Ningún operador todavía.');
      for (const o of all) {
        console.log(`${o.email.padEnd(36)} ${o.role.padEnd(8)} ${o.active ? (o.activated ? 'activo' : 'pendiente de alta') : 'desactivado'}  ${o.displayName}`);
      }
      return undefined;
    }
    case 'create': {
      const [role, ...name] = rest;
      if (!email || !role || !name.length) return usage();
      const { operator, token } = await operators.createOperator({
        email: email.toLowerCase(), displayName: name.join(' '), role: role.toUpperCase()
      });
      console.log(`Creado: ${operator.email} (${operator.role})`);
      return printLink(token);
    }
    case 'reset': {
      if (!email) return usage();
      const { operator, token } = await operators.resetOperator({ email: email.toLowerCase() });
      console.log(`Alta rehecha para ${operator.email}. Su autenticador anterior ya no vale.`);
      return printLink(token);
    }
    case 'disable':
    case 'enable': {
      if (!email) return usage();
      const op = await operators.setActive({ email: email.toLowerCase(), active: command === 'enable' });
      return console.log(`${op.email}: ${op.active ? 'activado' : 'desactivado'}`);
    }
    default:
      return usage();
  }
}

run()
  .catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
