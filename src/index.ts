#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import mysql from 'mysql2/promise';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ensurePrivateDirectory, pruneExpiredCacheFiles, writePrivateFile } from './cache-retention.js';

// Configuration schema for Smithery
export const configSchema = z.object({
  MYSQL_HOST: z.string().default('localhost').describe('MySQL server hostname (default host)'),
  MYSQL_PORT: z.number().default(3306).describe('MySQL server port (default host)'),
  MYSQL_USER: z.string().default('root').describe('MySQL username (default host)'),
  MYSQL_PASSWORD: z.string().describe('MySQL password (required for default host)'),
  MYSQL_DATABASE: z.string().optional().describe('Default database name (optional)'),
  MYSQL_SSL: z.boolean().default(false).describe('Enable SSL connection (default host)'),
  MCP_MYSQL_CACHE_ENABLED: z.boolean().default(true).describe('Enable intelligent caching system'),
  // Multi-host support via environment variables pattern: MYSQL_HOST_<NAME>_*
  // Example: MYSQL_HOST_PROD_HOST, MYSQL_HOST_PROD_PORT, MYSQL_HOST_PROD_USER, etc.
});

const QueryParamsSchema = z.object({
  query: z.string().min(1, "Query cannot be empty"),
  params: z.array(z.any()).optional().default([])
});

interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string; // Optional - if not provided, connects to server with access to all databases
  ssl?: mysql.SslOptions | string;
}

interface HostConfig extends ConnectionConfig {
  name: string;
  isDefault?: boolean;
}

interface DataSourceClassification {
  type: 'crm' | 'ecommerce' | 'erp' | 'marketing' | 'support' | 'analytics' | 'warehouse' | 'operational' | 'unknown';
  businessFunction: string;
  dataTypes: string[];
  commonPatterns: string[];
  estimatedRecords?: number;
  primaryEntities?: string[];
}

interface HostInventory {
  name: string;
  config: HostConfig;
  status: 'connected' | 'error' | 'unknown';
  databases: string[];
  lastScanned?: Date;
  error?: string;
  connectionTest?: {
    success: boolean;
    responseTime: number;
    timestamp: Date;
  };
  classification?: DataSourceClassification;
  federationCapabilities?: {
    canJoinWith: string[];
    sharedIdentifiers: string[];
    commonColumns: { [database: string]: string[] };
  };
}

interface CacheConfig {
  enabled: boolean;
  baseDir: string;
  maxFileSize: number;
  retentionDays: number;
}

interface CacheInfo {
  enabled: boolean;
  filePath: string;
  note: string;
}

class MySQLMCPServer {
  private server: Server;
  private connections: Map<string, mysql.Connection> = new Map();
  private hostConfigs: Map<string, HostConfig> = new Map();
  private hostInventory: Map<string, HostInventory> = new Map();
  private defaultHostName: string = 'default';
  private cacheConfig: CacheConfig;

  constructor(userConfig?: Partial<z.infer<typeof configSchema>>) {
    this.server = new Server(
      {
        name: 'mysql-mcp-server',
        version: '3.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.loadHostConfigurations(userConfig);

    this.cacheConfig = {
      enabled: process.env.MCP_MYSQL_CACHE_ENABLED !== 'false' && (userConfig?.MCP_MYSQL_CACHE_ENABLED !== false),
      baseDir: process.env.MCP_MYSQL_CACHE_DIR || path.join(os.homedir(), '.mcp-mysql-cache'),
      maxFileSize: parseInt(process.env.MCP_MYSQL_CACHE_MAX_SIZE || '52428800'), // 50MB default
      retentionDays: parseInt(process.env.MCP_MYSQL_CACHE_RETENTION_DAYS || '30')
    };

    if (this.cacheConfig.enabled) {
      void ensurePrivateDirectory(this.cacheConfig.baseDir)
        .then(() => pruneExpiredCacheFiles(this.cacheConfig.baseDir, this.cacheConfig.retentionDays))
        .then(({ scannedFiles, removedFiles }) => {
          console.error(`Cache retention checked ${scannedFiles} file(s); removed ${removedFiles} expired file(s).`);
        })
        .catch(error => {
          console.error('Cache retention cleanup failed:', error);
        });
    }

    this.setupHandlers();
  }

  private parseMyCnf(filePath: string): Record<string, Record<string, string>> {
    const sections: Record<string, Record<string, string>> = {};
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return sections;
    }

    let current: string | null = null;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
      if (trimmed.startsWith('!')) continue; // !include / !includedir not supported

      const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        current = sectionMatch[1].trim().toLowerCase();
        if (!sections[current]) sections[current] = {};
        continue;
      }

      if (!current) continue;

      const eq = trimmed.indexOf('=');
      let key: string;
      let value: string;
      if (eq === -1) {
        key = trimmed;
        value = '';
      } else {
        key = trimmed.slice(0, eq).trim();
        value = trimmed.slice(eq + 1).trim();
      }

      // Strip inline comments (MySQL: # starts a comment outside quotes)
      if (value && !/^['"]/.test(value)) {
        const hashIdx = value.indexOf('#');
        if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
      }

      // Strip surrounding quotes
      if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
          value = value.slice(1, -1);
        }
      }

      // Normalize key: MySQL treats - and _ as equivalent
      key = key.toLowerCase().replace(/-/g, '_');
      sections[current][key] = value;
    }

    return sections;
  }

  private hostConfigFromCnfSection(
    name: string,
    section: Record<string, string>,
    isDefault = false
  ): HostConfig {
    const sslVal = section['ssl'] || section['ssl_mode'];
    const sslEnabled = sslVal !== undefined && sslVal !== '' && sslVal.toLowerCase() !== 'disabled' && sslVal.toLowerCase() !== 'false' && sslVal !== '0';
    return {
      name,
      host: section['host'] || 'localhost',
      port: section['port'] ? parseInt(section['port']) : 3306,
      user: section['user'] || 'root',
      password: section['password'] || '',
      database: section['database'],
      ssl: sslEnabled ? {} : undefined,
      isDefault
    };
  }

  private loadHostConfigurations(userConfig?: Partial<z.infer<typeof configSchema>>) {
    // Parse ~/.my.cnf if present; used as a fallback source for credentials.
    const myCnfPath = path.join(os.homedir(), '.my.cnf');
    const ignoreMyCnf = process.env.MCP_MYSQL_IGNORE_MY_CNF === 'true';
    const myCnf = ignoreMyCnf ? {} : this.parseMyCnf(myCnfPath);

    if (Object.keys(myCnf).length > 0) {
      const hasPassword = Object.values(myCnf).some(s => s['password']);
      console.error('');
      console.error('⚠️  WARNING: Auto-loading MySQL credentials from ~/.my.cnf');
      console.error(`   File: ${myCnfPath}`);
      console.error(`   Sections: ${Object.keys(myCnf).join(', ')}`);
      if (hasPassword) {
        console.error('   This file contains passwords that will be used by the MCP server.');
      }
      console.error('   Environment variables (MYSQL_*) take precedence over ~/.my.cnf values.');
      console.error('   To disable, set MCP_MYSQL_IGNORE_MY_CNF=true');
      console.error('');
    } else if (ignoreMyCnf && fs.existsSync(myCnfPath)) {
      console.error(`MCP_MYSQL_IGNORE_MY_CNF=true — skipping ${myCnfPath}`);
    }

    const clientSection = myCnf['client'] || {};

    const cnfSslVal = clientSection['ssl'] || clientSection['ssl_mode'];
    const cnfSslEnabled = cnfSslVal !== undefined && cnfSslVal !== '' && cnfSslVal.toLowerCase() !== 'disabled' && cnfSslVal.toLowerCase() !== 'false' && cnfSslVal !== '0';

    // Load default host configuration.
    // Precedence: env var > userConfig > ~/.my.cnf [client] > hardcoded default.
    const defaultConfig: HostConfig = {
      name: this.defaultHostName,
      host: process.env.MYSQL_HOST || userConfig?.MYSQL_HOST || clientSection['host'] || 'localhost',
      port: process.env.MYSQL_PORT
        ? parseInt(process.env.MYSQL_PORT)
        : (userConfig?.MYSQL_PORT || (clientSection['port'] ? parseInt(clientSection['port']) : 3306)),
      user: process.env.MYSQL_USER || userConfig?.MYSQL_USER || clientSection['user'] || 'root',
      password: process.env.MYSQL_PASSWORD || userConfig?.MYSQL_PASSWORD || clientSection['password'] || '',
      database: process.env.MYSQL_DATABASE || userConfig?.MYSQL_DATABASE || clientSection['database'],
      ssl: (process.env.MYSQL_SSL === 'true' || userConfig?.MYSQL_SSL || cnfSslEnabled) ? {} : undefined,
      isDefault: true
    };

    this.hostConfigs.set(this.defaultHostName, defaultConfig);

    // Discover named hosts from env vars (MYSQL_HOST_<NAME>_*) and from my.cnf
    // sections matching [client<name>] / [client-<name>] / [client_<name>]
    // (the --defaults-group-suffix convention).
    const hostNames = new Set<string>();

    for (const [key] of Object.entries(process.env)) {
      const match = key.match(/^MYSQL_HOST_([^_]+)_/);
      if (match) {
        hostNames.add(match[1].toLowerCase());
      }
    }

    const cnfNamedSections: Record<string, Record<string, string>> = {};
    for (const [sectionName, values] of Object.entries(myCnf)) {
      const m = sectionName.match(/^client[-_]?(.+)$/);
      if (!m) continue;
      const named = m[1].toLowerCase();
      cnfNamedSections[named] = values;
      hostNames.add(named);
    }

    for (const hostName of hostNames) {
      const prefix = `MYSQL_HOST_${hostName.toUpperCase()}`;
      const cnf = cnfNamedSections[hostName] || {};
      const sslEnv = process.env[`${prefix}_SSL`];
      const cnfSsl = cnf['ssl'] || cnf['ssl_mode'];
      const cnfSslOn = cnfSsl !== undefined && cnfSsl !== '' && cnfSsl.toLowerCase() !== 'disabled' && cnfSsl.toLowerCase() !== 'false' && cnfSsl !== '0';

      const hostConfig: HostConfig = {
        name: hostName,
        host: process.env[`${prefix}_HOST`] || cnf['host'] || 'localhost',
        port: process.env[`${prefix}_PORT`]
          ? parseInt(process.env[`${prefix}_PORT`]!)
          : (cnf['port'] ? parseInt(cnf['port']) : 3306),
        user: process.env[`${prefix}_USER`] || cnf['user'] || 'root',
        password: process.env[`${prefix}_PASSWORD`] || cnf['password'] || '',
        database: process.env[`${prefix}_DATABASE`] || cnf['database'],
        ssl: (sslEnv === 'true' || (sslEnv === undefined && cnfSslOn)) ? {} : undefined
      };

      // Only register if a password is available (required to connect).
      if (hostConfig.password) {
        this.hostConfigs.set(hostName, hostConfig);
      }
    }

    console.error(`Configured ${this.hostConfigs.size} MySQL host(s): ${Array.from(this.hostConfigs.keys()).join(', ')}`);
    
    // Initialize host inventory and scan databases
    this.initializeHostInventory();
  }

  private async initializeHostInventory() {
    console.error('Initializing host inventory and scanning databases...');
    
    for (const [hostName, hostConfig] of this.hostConfigs) {
      const inventory: HostInventory = {
        name: hostName,
        config: hostConfig,
        status: 'unknown',
        databases: []
      };
      
      this.hostInventory.set(hostName, inventory);
      
      // Scan databases in background (don't block initialization)
      this.scanHostDatabases(hostName).catch(error => {
        console.error(`Failed to scan databases for host '${hostName}':`, error);
        inventory.status = 'error';
        inventory.error = error.message;
      });
    }
  }

  private async scanHostDatabases(hostName: string): Promise<void> {
    const inventory = this.hostInventory.get(hostName);
    if (!inventory) return;

    try {
      const startTime = Date.now();
      const connection = await this.createConnection(hostName);
      const responseTime = Date.now() - startTime;
      
      // Test connection and get databases
      const [dbResult] = await connection.execute('SHOW DATABASES');
      const databases = (dbResult as any[])
        .map(row => row.Database)
        .filter(db => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(db));
      
      // Update inventory
      inventory.status = 'connected';
      inventory.databases = databases;
      inventory.lastScanned = new Date();
      inventory.connectionTest = {
        success: true,
        responseTime,
        timestamp: new Date()
      };
      
      console.error(`✅ Host '${hostName}': Found ${databases.length} databases - ${databases.join(', ')}`);
      
      // Classify the data source based on discovered data
      inventory.classification = await this.classifyDataSource(hostName, databases, connection);
      inventory.federationCapabilities = await this.analyzeFederationCapabilities(hostName, databases, connection);
      
      console.error(`📊 Host '${hostName}': Classified as ${inventory.classification.type} (${inventory.classification.businessFunction})`);
      
      // Cache the host inventory
      await this.cacheHostInventory();
      
    } catch (error) {
      inventory.status = 'error';
      inventory.error = error instanceof Error ? error.message : 'Unknown error';
      console.error(`❌ Host '${hostName}': Connection failed - ${inventory.error}`);
    }
  }

  private async cacheHostInventory(): Promise<void> {
    try {
      const inventoryData = {
        timestamp: new Date().toISOString(),
        hosts: Object.fromEntries(
          Array.from(this.hostInventory.entries()).map(([name, inventory]) => [
            name,
            {
              name: inventory.name,
              status: inventory.status,
              databases: inventory.databases,
              lastScanned: inventory.lastScanned?.toISOString(),
              connectionTest: inventory.connectionTest,
              error: inventory.error
            }
          ])
        )
      };

      await this.saveToCache(
        inventoryData,
        'host-inventory',
        'inventory',
        undefined,
        undefined,
        'all-hosts'
      );
    } catch (error) {
      console.error('Failed to cache host inventory:', error);
    }
  }

  public getHostInventory(): Map<string, HostInventory> {
    return new Map(this.hostInventory);
  }

  public getAvailableHosts(): string[] {
    return Array.from(this.hostInventory.keys());
  }

  public getHostDatabases(hostName?: string): string[] {
    const targetHost = hostName || this.defaultHostName;
    const inventory = this.hostInventory.get(targetHost);
    return inventory ? inventory.databases : [];
  }

  public getAllDatabasesAcrossHosts(): { host: string, databases: string[] }[] {
    return Array.from(this.hostInventory.entries())
      .filter(([, inventory]) => inventory.status === 'connected')
      .map(([hostName, inventory]) => ({
        host: hostName,
        databases: inventory.databases
      }));
  }

  private async classifyDataSource(hostName: string, databases: string[], connection: mysql.Connection): Promise<DataSourceClassification> {
    const classification: DataSourceClassification = {
      type: 'unknown',
      businessFunction: 'Unknown',
      dataTypes: [],
      commonPatterns: [],
      primaryEntities: []
    };

    try {
      // Analyze table names and structures across databases to classify the data source
      let allTables: string[] = [];
      let totalRecords = 0;
      
      for (const database of databases) {
        try {
          const [tables] = await connection.execute(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [database]);
          const tableNames = (tables as any[]).map(t => t.TABLE_NAME.toLowerCase());
          allTables = allTables.concat(tableNames);
          
          // Get rough record count
          const [counts] = await connection.execute(`
            SELECT SUM(TABLE_ROWS) as total_rows 
            FROM information_schema.TABLES 
            WHERE TABLE_SCHEMA = ? AND TABLE_ROWS IS NOT NULL
          `, [database]);
          totalRecords += (counts as any[])[0]?.total_rows || 0;
        } catch (error) {
          // Skip database if we can't access it
          continue;
        }
      }
      
      classification.estimatedRecords = totalRecords;
      
      // Classification logic based on table patterns
      const tablePatterns = allTables.join(' ');
      
      // CRM System Detection
      if (this.containsPatterns(tablePatterns, ['lead', 'contact', 'account', 'opportunity', 'campaign']) || 
          this.containsPatterns(allTables.join(' '), ['sf_', 'salesforce', 'hubspot', 'pipedrive'])) {
        classification.type = 'crm';
        classification.businessFunction = 'Customer Relationship Management';
        classification.dataTypes = ['customers', 'leads', 'opportunities', 'contacts', 'campaigns'];
        classification.commonPatterns = ['lead_source', 'opportunity_stage', 'contact_status'];
        classification.primaryEntities = allTables.filter(t => 
          ['lead', 'contact', 'account', 'opportunity', 'customer'].some(entity => t.includes(entity)));
      }
      
      // E-commerce System Detection
      else if (this.containsPatterns(tablePatterns, ['order', 'product', 'cart', 'payment', 'inventory']) ||
               this.containsPatterns(allTables.join(' '), ['woo_', 'shopify', 'magento', 'ecommerce'])) {
        classification.type = 'ecommerce';
        classification.businessFunction = 'E-commerce & Retail Operations';
        classification.dataTypes = ['orders', 'products', 'customers', 'payments', 'inventory'];
        classification.commonPatterns = ['order_status', 'product_sku', 'payment_method', 'customer_email'];
        classification.primaryEntities = allTables.filter(t => 
          ['order', 'product', 'customer', 'payment', 'cart', 'inventory'].some(entity => t.includes(entity)));
      }
      
      // ERP System Detection
      else if (this.containsPatterns(tablePatterns, ['invoice', 'vendor', 'purchase', 'supplier', 'procurement']) ||
               this.containsPatterns(allTables.join(' '), ['sap_', 'oracle', 'erp_', 'financial'])) {
        classification.type = 'erp';
        classification.businessFunction = 'Enterprise Resource Planning';
        classification.dataTypes = ['financials', 'procurement', 'inventory', 'hr', 'manufacturing'];
        classification.commonPatterns = ['invoice_number', 'vendor_id', 'cost_center', 'gl_account'];
        classification.primaryEntities = allTables.filter(t => 
          ['invoice', 'vendor', 'purchase', 'employee', 'asset'].some(entity => t.includes(entity)));
      }
      
      // Marketing System Detection
      else if (this.containsPatterns(tablePatterns, ['campaign', 'email', 'newsletter', 'subscriber', 'segment']) ||
               this.containsPatterns(allTables.join(' '), ['mailchimp', 'marketo', 'pardot', 'marketing'])) {
        classification.type = 'marketing';
        classification.businessFunction = 'Marketing Automation & Analytics';
        classification.dataTypes = ['campaigns', 'emails', 'subscribers', 'analytics', 'segments'];
        classification.commonPatterns = ['campaign_id', 'email_status', 'subscriber_status', 'open_rate'];
        classification.primaryEntities = allTables.filter(t => 
          ['campaign', 'email', 'subscriber', 'segment', 'list'].some(entity => t.includes(entity)));
      }
      
      // Support System Detection
      else if (this.containsPatterns(tablePatterns, ['ticket', 'incident', 'support', 'case', 'resolution']) ||
               this.containsPatterns(allTables.join(' '), ['zendesk', 'freshdesk', 'servicedesk', 'helpdesk'])) {
        classification.type = 'support';
        classification.businessFunction = 'Customer Support & Service';
        classification.dataTypes = ['tickets', 'incidents', 'customers', 'agents', 'knowledge_base'];
        classification.commonPatterns = ['ticket_status', 'priority', 'category', 'resolution_time'];
        classification.primaryEntities = allTables.filter(t => 
          ['ticket', 'incident', 'case', 'agent', 'customer'].some(entity => t.includes(entity)));
      }
      
      // Analytics/Warehouse Detection
      else if (this.containsPatterns(tablePatterns, ['fact_', 'dim_', 'analytics', 'reporting', 'dashboard']) ||
               this.containsPatterns(allTables.join(' '), ['warehouse', 'dwh_', 'analytics', 'bi_'])) {
        classification.type = 'warehouse';
        classification.businessFunction = 'Data Warehousing & Business Intelligence';
        classification.dataTypes = ['dimensions', 'facts', 'aggregations', 'metrics', 'kpis'];
        classification.commonPatterns = ['date_key', 'fact_', 'dim_', 'measure_', 'metric_'];
        classification.primaryEntities = allTables.filter(t => 
          t.includes('fact_') || t.includes('dim_') || ['analytics', 'reporting', 'dashboard'].some(entity => t.includes(entity)));
      }
      
      // Operational Database Detection (fallback)
      else {
        classification.type = 'operational';
        classification.businessFunction = 'Operational Database System';
        classification.dataTypes = ['transactional_data', 'operational_records'];
        classification.commonPatterns = ['id', 'created_at', 'updated_at', 'status'];
        classification.primaryEntities = allTables.slice(0, 5); // Top 5 tables
      }
      
    } catch (error) {
      console.error(`Failed to classify data source '${hostName}':`, error);
    }
    
    return classification;
  }
  
  private containsPatterns(text: string, patterns: string[]): boolean {
    return patterns.some(pattern => text.toLowerCase().includes(pattern.toLowerCase()));
  }
  
  private async analyzeFederationCapabilities(hostName: string, databases: string[], connection: mysql.Connection): Promise<any> {
    const capabilities = {
      canJoinWith: [] as string[],
      sharedIdentifiers: [] as string[],
      commonColumns: {} as { [database: string]: string[] }
    };
    
    try {
      // Look for common identifier patterns that could be used for federation
      const commonIdentifierPatterns = ['customer_id', 'user_id', 'email', 'customer_email', 'user_email', 'account_id', 'company_id'];
      
      for (const database of databases) {
        try {
          const [columns] = await connection.execute(`
            SELECT DISTINCT COLUMN_NAME 
            FROM information_schema.COLUMNS 
            WHERE TABLE_SCHEMA = ? 
              AND COLUMN_NAME REGEXP ?
          `, [database, '(customer|user|email|account|company)']);
          
          const foundColumns = (columns as any[]).map(c => c.COLUMN_NAME.toLowerCase());
          capabilities.commonColumns[database] = foundColumns;
          
          // Add to shared identifiers if we find common patterns
          foundColumns.forEach(col => {
            if (commonIdentifierPatterns.some(pattern => col.includes(pattern)) && 
                !capabilities.sharedIdentifiers.includes(col)) {
              capabilities.sharedIdentifiers.push(col);
            }
          });
        } catch (error) {
          // Skip database if we can't access it
          continue;
        }
      }
      
      // Determine which other hosts this one can potentially join with
      for (const [otherHostName, otherInventory] of this.hostInventory) {
        if (otherHostName !== hostName && otherInventory.federationCapabilities) {
          const sharedIds = capabilities.sharedIdentifiers.filter(id => 
            otherInventory.federationCapabilities!.sharedIdentifiers.includes(id)
          );
          
          if (sharedIds.length > 0) {
            capabilities.canJoinWith.push(otherHostName);
          }
        }
      }
      
    } catch (error) {
      console.error(`Failed to analyze federation capabilities for '${hostName}':`, error);
    }
    
    return capabilities;
  }

  private async ensureCacheDirectory(subDir?: string, hostName?: string): Promise<string> {
    if (!this.cacheConfig.enabled) {
      throw new Error('Caching is disabled');
    }

    let targetDir = this.cacheConfig.baseDir;
    await ensurePrivateDirectory(targetDir);
    
    // Add host-specific subdirectory if not default host
    if (hostName && hostName !== this.defaultHostName) {
      targetDir = path.join(targetDir, `host-${hostName}`);
      await ensurePrivateDirectory(targetDir);
    }
    
    if (subDir) {
      for (const segment of subDir.split(/[\\/]/).filter(Boolean)) {
        targetDir = path.join(targetDir, segment);
        await ensurePrivateDirectory(targetDir);
      }
    }
    return targetDir;
  }

  private generateCacheFileName(operation: string, hostName?: string, database?: string, query?: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const hostPrefix = hostName && hostName !== this.defaultHostName ? `${hostName}_` : '';
    const dbPrefix = database ? `${database}_` : '';
    const queryHash = query ? `_${this.hashString(query.substring(0, 50))}` : '';
    return `${timestamp}_${hostPrefix}${dbPrefix}${operation}${queryHash}.json`;
  }

  private generateCacheKey(operation: string, hostName?: string, database?: string, query?: string): string {
    const hostPrefix = hostName && hostName !== this.defaultHostName ? `${hostName}_` : '';
    const dbPrefix = database ? `${database}_` : '';
    const queryHash = query ? `_${this.hashString(query)}` : '';
    return `${hostPrefix}${dbPrefix}${operation}${queryHash}`;
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }

  private async readFromCache(
    operation: string,
    subDir: string,
    hostName?: string,
    database?: string,
    query?: string,
    ttlHours: number = 1
  ): Promise<any | null> {
    if (!this.cacheConfig.enabled) {
      return null;
    }

    try {
      let cacheDir = this.cacheConfig.baseDir;
      
      // Add host-specific subdirectory if not default host
      if (hostName && hostName !== this.defaultHostName) {
        cacheDir = path.join(cacheDir, `host-${hostName}`);
      }
      
      cacheDir = path.join(cacheDir, subDir);
      const cacheKey = this.generateCacheKey(operation, hostName, database, query);
      
      // Check if cache directory exists
      try {
        await fs.promises.access(cacheDir);
      } catch {
        return null;
      }

      // Find matching cache files
      const files = await fs.promises.readdir(cacheDir);
      const matchingFiles = files.filter(file => 
        file.includes(cacheKey) && file.endsWith('.json')
      );

      if (matchingFiles.length === 0) {
        return null;
      }

      // Sort by timestamp (newest first) and get the latest
      matchingFiles.sort().reverse();
      const latestFile = matchingFiles[0];
      const filePath = path.join(cacheDir, latestFile);

      // Check if file is within TTL
      const stats = await fs.promises.stat(filePath);
      const ageHours = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);
      
      if (ageHours > ttlHours) {
        console.error(`Cache expired for ${operation} (${ageHours.toFixed(1)}h old, TTL: ${ttlHours}h)`);
        return null;
      }

      // Read and parse cache file
      const content = await fs.promises.readFile(filePath, 'utf8');
      const cacheData = JSON.parse(content);
      
      console.error(`Cache hit for ${operation} (${ageHours.toFixed(1)}h old): ${filePath}`);
      return {
        data: cacheData.data,
        cacheInfo: {
          enabled: true,
          filePath,
          age: `${ageHours.toFixed(1)} hours`,
          note: `Loaded from cache (TTL: ${ttlHours}h)`
        }
      };
    } catch (error) {
      console.error('Failed to read from cache:', error);
      return null;
    }
  }

  private async saveToCache(
    data: any,
    operation: string,
    subDir: string,
    hostName?: string,
    database?: string,
    query?: string
  ): Promise<string | null> {
    if (!this.cacheConfig.enabled) {
      return null;
    }

    try {
      const cacheDir = await this.ensureCacheDirectory(subDir, hostName);
      const fileName = this.generateCacheFileName(operation, hostName, database, query);
      const filePath = path.join(cacheDir, fileName);
      
      const hostConfig = this.getHostConfig(hostName);
      const cacheData = {
        timestamp: new Date().toISOString(),
        server: { host: hostConfig.host, port: hostConfig.port, hostName: hostConfig.name },
        database: database || 'server',
        operation,
        query: query || null,
        data
      };

      const content = JSON.stringify(cacheData, null, 2);
      
      if (content.length > this.cacheConfig.maxFileSize) {
        console.error(`Cache file too large (${content.length} bytes), skipping cache for ${operation}`);
        return null;
      }

      await writePrivateFile(filePath, content);
      console.error(`Cached ${operation} results to: ${filePath}`);
      
      return filePath;
    } catch (error) {
      console.error('Failed to cache data:', error);
      return null;
    }
  }

  private getHostConfig(hostName?: string): HostConfig {
    const targetHost = hostName || this.defaultHostName;
    const config = this.hostConfigs.get(targetHost);
    
    if (!config) {
      throw new Error(`Host configuration '${targetHost}' not found. Available hosts: ${Array.from(this.hostConfigs.keys()).join(', ')}`);
    }
    
    return config;
  }

  private async createConnection(hostName?: string, database?: string): Promise<mysql.Connection> {
    const hostConfig = this.getHostConfig(hostName);
    const targetDb = database || hostConfig.database;
    const connectionKey = `${hostConfig.name}:${targetDb || 'default'}`;
    
    // Check if we already have a suitable connection
    const existingConnection = this.connections.get(connectionKey);
    if (existingConnection) {
      try {
        await existingConnection.ping();
        return existingConnection;
      } catch (error) {
        // Connection is stale, remove it
        this.connections.delete(connectionKey);
      }
    }

    // Create new connection
    try {
      const connectionConfig = {
        host: hostConfig.host,
        port: hostConfig.port,
        user: hostConfig.user,
        password: hostConfig.password,
        ssl: hostConfig.ssl,
        timezone: 'Z',
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        connectTimeout: 10000
      };
      
      // Only set database if specified
      if (targetDb) {
        (connectionConfig as any).database = targetDb;
      }
      
      const connection = await mysql.createConnection(connectionConfig);
      await connection.ping();
      
      // Cache the connection
      this.connections.set(connectionKey, connection);
      
      console.error(`Connected to MySQL ${hostConfig.name} (${hostConfig.host}:${hostConfig.port})${targetDb ? ` database: ${targetDb}` : ' (server-wide access)'}`);
      return connection;
    } catch (error) {
      console.error(`Database connection failed for host '${hostConfig.name}':`, error);
      
      // Check if this is a tool scanning environment
      if (process.env.SMITHERY_SCAN_MODE === 'true') {
        console.error('Running in scan mode - connection errors are expected');
        throw new Error('MySQL connection required for operation');
      }
      
      throw new Error(`Cannot connect to MySQL host '${hostConfig.name}': ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private isReadOnlyQuery(query: string): boolean {
    const trimmed = query.trim().toLowerCase();
    const readOnlyPrefixes = ['select', 'show', 'describe', 'explain', 'desc'];
    return readOnlyPrefixes.some(prefix => trimmed.startsWith(prefix));
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [
        {
          name: 'mysql_query',
          description: 'Execute a read-only SQL query against MySQL databases. Supports SELECT, SHOW, DESCRIBE, and EXPLAIN statements.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The SQL query to execute (read-only operations only). Use database.table syntax for cross-database queries.'
              },
              params: {
                type: 'array',
                description: 'Optional array of parameters for prepared statement',
                items: { type: 'string' }
              },
              database: {
                type: 'string',
                description: 'Optional database name to connect to for this query'
              },
              host: {
                type: 'string',
                description: 'Optional host name to connect to (defaults to "default" host)'
              }
            },
            required: ['query']
          }
        },
        {
          name: 'mysql_schema',
          description: 'Get comprehensive schema information including tables, relationships, constraints, and data patterns.',
          inputSchema: {
            type: 'object',
            properties: {
              database: {
                type: 'string',
                description: 'Database name to analyze (if not specified, analyzes current/default database)'
              },
              table: {
                type: 'string',
                description: 'Optional table name to get specific table analysis (use database.table for cross-database)'
              },
              host: {
                type: 'string',
                description: 'Optional host name to connect to (defaults to "default" host)'
              },
              include_relationships: {
                type: 'boolean',
                description: 'Include foreign key relationships and table connections',
                default: true
              },
              include_sample_data: {
                type: 'boolean', 
                description: 'Include sample data and value distributions',
                default: false
              },
              sample_size: {
                type: 'number',
                description: 'Number of sample rows to analyze (max 1000)',
                default: 100
              }
            }
          }
        },
        {
          name: 'mysql_analyze_tables',
          description: 'Analyze table relationships and suggest optimal query patterns for user behavior analysis.',
          inputSchema: {
            type: 'object',
            properties: {
              tables: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of table names to analyze for relationships'
              },
              host: {
                type: 'string',
                description: 'Optional host name to connect to (defaults to "default" host)'
              },
              analysis_type: {
                type: 'string',
                enum: ['relationships', 'user_behavior', 'data_flow'],
                description: 'Type of analysis to perform',
                default: 'relationships'
              }
            },
            required: ['tables']
          }
        },
        {
          name: 'mysql_inventory',
          description: 'Get comprehensive inventory of all configured MySQL hosts and their accessible databases.',
          inputSchema: {
            type: 'object',
            properties: {
              refresh: {
                type: 'boolean',
                description: 'Force refresh of host inventory by re-scanning all hosts',
                default: false
              },
              host: {
                type: 'string',
                description: 'Get inventory for specific host only (omit for all hosts)'
              }
            }
          }
        },
        {
          name: 'mysql_cross_host_query',
          description: 'Execute queries across multiple MySQL hosts and combine results for comprehensive analysis.',
          inputSchema: {
            type: 'object',
            properties: {
              queries: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    host: { type: 'string', description: 'Host name to execute query on' },
                    database: { type: 'string', description: 'Database name (optional)' },
                    query: { type: 'string', description: 'SQL query to execute' },
                    alias: { type: 'string', description: 'Alias for this query result (optional)' }
                  },
                  required: ['host', 'query']
                },
                description: 'Array of queries to execute across different hosts'
              },
              combine_strategy: {
                type: 'string',
                enum: ['separate', 'union', 'comparison', 'correlation'],
                description: 'How to combine results: separate (individual results), union (merge similar data), comparison (side-by-side), correlation (find relationships)',
                default: 'separate'
              },
              analysis_focus: {
                type: 'string',
                enum: ['performance', 'data_consistency', 'user_behavior', 'business_metrics'],
                description: 'Focus area for cross-host analysis',
                default: 'data_consistency'
              }
            },
            required: ['queries']
          }
        },
        {
          name: 'mysql_discover_analytics',
          description: 'Intelligently discover and analyze database structure with expert data analytics insights. Use summary mode first for large servers.',
          inputSchema: {
            type: 'object',
            properties: {
              databases: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional list of databases to analyze (if not specified, discovers all accessible databases)'
              },
              host: {
                type: 'string',
                description: 'Optional host name to connect to (defaults to "default" host)'
              },
              focus_area: {
                type: 'string',
                enum: ['user_behavior', 'sales_analytics', 'engagement', 'general'],
                description: 'Analytics focus area to guide discovery',
                default: 'general'
              },
              include_recommendations: {
                type: 'boolean',
                description: 'Include expert analytics recommendations and queries',
                default: true
              },
              cross_database_analysis: {
                type: 'boolean',
                description: 'Analyze relationships across databases',
                default: true
              },
              detail_level: {
                type: 'string',
                enum: ['summary', 'detailed', 'full'],
                description: 'Level of detail: summary (overview only), detailed (without sample data), full (everything)',
                default: 'summary'
              },
              max_tables_per_db: {
                type: 'number',
                description: 'Maximum number of tables to analyze per database (default: 20)',
                default: 20,
                minimum: 1,
                maximum: 100
              },
              sample_data_limit: {
                type: 'number',
                description: 'Maximum sample rows per table (default: 3, max: 10)',
                default: 3,
                minimum: 0,
                maximum: 10
              },
              page: {
                type: 'number',
                description: 'Page number for pagination (1-based, default: 1)',
                default: 1,
                minimum: 1
              },
              page_size: {
                type: 'number',
                description: 'Number of databases to analyze per page (default: 5, max: 10)',
                default: 5,
                minimum: 1,
                maximum: 10
              }
            }
          }
        }
      ];

      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'mysql_query':
            return await this.handleQuery(args);
          case 'mysql_schema':
            return await this.handleSchema(args);
          case 'mysql_analyze_tables':
            return await this.handleAnalyzeTables(args);
          case 'mysql_discover_analytics':
            return await this.handleDiscoverAnalytics(args);
          case 'mysql_inventory':
            return await this.handleInventory(args);
          case 'mysql_cross_host_query':
            return await this.handleCrossHostQuery(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${errorMessage}`
            }
          ]
        };
      }
    });
  }

  private async handleQuery(args: any) {
    const parsed = QueryParamsSchema.parse(args);
    
    if (!this.isReadOnlyQuery(parsed.query)) {
      throw new Error('Only read-only queries (SELECT, SHOW, DESCRIBE, EXPLAIN) are allowed');
    }

    if (parsed.query.length > 10000) {
      throw new Error('Query too long (max 10,000 characters)');
    }

    const connection = await this.createConnection(args.host, args.database);
    
    try {
      const startTime = Date.now();
      const [rows] = await connection.execute(parsed.query, parsed.params);
      const endTime = Date.now();
      
      const rowCount = Array.isArray(rows) ? rows.length : 0;
      const executionTime = endTime - startTime;

      const resultData: any = {
        query: {
          sql: parsed.query,
          parameters: parsed.params,
          executionTime: `${executionTime}ms`,
          rowCount
        },
        data: rows,
        analytics: {
          summary: `Executed ${parsed.query.trim().split(' ')[0].toUpperCase()} query returning ${rowCount} rows in ${executionTime}ms`,
          performance: executionTime > 1000 ? 'Consider adding indexes if this query runs frequently' : 'Good performance'
        }
      };

      // Cache the query results
      const cachePath = await this.saveToCache(
        resultData,
        'query',
        `queries/${new Date().toISOString().split('T')[0]}`,
        args.host,
        args.database,
        parsed.query
      );

      // Add cache information to the result if caching succeeded
      if (cachePath) {
        resultData.cache = {
          enabled: true,
          filePath: cachePath,
          note: 'Raw MySQL output cached for comprehensive analysis'
        };
      }

      // Add host context information
      resultData.hostContext = {
        queriedHost: args.host || 'default',
        availableHosts: this.getAvailableHosts(),
        hostDatabases: this.getHostDatabases(args.host)
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(resultData, null, 2)
          }
        ]
      };
    } catch (error) {
      console.error('Query execution error:', error);
      throw new Error(`Query failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleSchema(args: any) {
    const connection = await this.createConnection(args?.host, args?.database);
    const includeRelationships = args?.include_relationships !== false;
    const includeSampleData = args?.include_sample_data === true;
    const sampleSize = Math.min(args?.sample_size || 100, 1000);
    const targetDatabase = args?.database || this.getHostConfig(args?.host).database;
    
    if (args?.table) {
      // Handle database.table format
      let tableName = args.table;
      let dbName = targetDatabase;
      if (tableName.includes('.')) {
        [dbName, tableName] = tableName.split('.', 2);
      }
      return await this.getDetailedTableSchema(connection, tableName, dbName, includeRelationships, includeSampleData, sampleSize, args?.host);
    } else {
      return await this.getDatabaseOverview(connection, targetDatabase, includeRelationships, args?.host);
    }
  }

  private async getDetailedTableSchema(connection: mysql.Connection, tableName: string, databaseName: string | undefined, includeRelationships: boolean, includeSampleData: boolean, sampleSize: number, hostName?: string) {
    // Check cache first for schema data (TTL: 1 hour)
    const cacheKey = `table-${tableName}-${includeRelationships}-${includeSampleData}-${sampleSize}`;
    const cached = await this.readFromCache(
      'table-schema',
      'schema-snapshots',
      hostName,
      databaseName,
      cacheKey,
      1 // 1 hour TTL
    );
    
    if (cached) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ...cached.data,
              cache: cached.cacheInfo
            }, null, 2)
          }
        ]
      };
    }

    const [columns] = await connection.execute(`DESCRIBE \`${tableName}\``);
    const [indexes] = await connection.execute(`SHOW INDEX FROM \`${tableName}\``);
    
    let foreignKeys: any[] = [];
    let referencedBy: any[] = [];
    let constraints: any[] = [];
    let sampleData: any = null;
    let dataProfile: any = null;

    if (includeRelationships) {
      const [foreignKeysResult] = await connection.execute(`
        SELECT 
          COLUMN_NAME,
          REFERENCED_TABLE_NAME,
          REFERENCED_COLUMN_NAME,
          CONSTRAINT_NAME
        FROM information_schema.KEY_COLUMN_USAGE 
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      `, [databaseName || this.getHostConfig(hostName).database, tableName]);
      foreignKeys = foreignKeysResult as any[];

      const [referencedByResult] = await connection.execute(`
        SELECT 
          TABLE_NAME as referencing_table,
          COLUMN_NAME as referencing_column,
          CONSTRAINT_NAME
        FROM information_schema.KEY_COLUMN_USAGE 
        WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?
      `, [databaseName || this.getHostConfig(hostName).database, tableName]);
      referencedBy = referencedByResult as any[];

      const [constraintsResult] = await connection.execute(`
        SELECT 
          CONSTRAINT_NAME,
          CONSTRAINT_TYPE,
          COLUMN_NAME
        FROM information_schema.TABLE_CONSTRAINTS tc
        LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME 
        WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ?
      `, [databaseName || this.getHostConfig(hostName).database, tableName]);
      constraints = constraintsResult as any[];
    }

    if (includeSampleData) {
      const [rows] = await connection.execute(`SELECT * FROM \`${tableName}\` LIMIT ?`, [sampleSize]);
      sampleData = rows;

      const [rowCount] = await connection.execute(`SELECT COUNT(*) as total FROM \`${tableName}\``) as any;
      
      dataProfile = {
        totalRows: rowCount[0]?.total || 0,
        sampleSize: Array.isArray(rows) ? rows.length : 0
      };

      if (Array.isArray(columns) && Array.isArray(rows) && rows.length > 0) {
        dataProfile.columnAnalysis = {};
        
        for (const col of columns as any[]) {
          const colName = col.Field;
          const values = rows.map((row: any) => row[colName]).filter(v => v !== null);
          
          dataProfile.columnAnalysis[colName] = {
            dataType: col.Type,
            nullable: col.Null === 'YES',
            nonNullValues: values.length,
            uniqueValues: new Set(values).size,
            sampleValues: [...new Set(values)].slice(0, 10)
          };
        }
      }
    }

    const schemaData: any = {
      table: tableName,
      columns,
      indexes,
      relationships: {
        foreignKeys,
        referencedBy
      },
      constraints,
      ...(dataProfile && { dataProfile }),
      ...(sampleData && { sampleData })
    };

    // Cache the schema analysis
    const cachePath = await this.saveToCache(
      schemaData,
      'table-schema',
      `schema-snapshots`,
      hostName,
      databaseName,
      `table-${tableName}`
    );

    if (cachePath) {
      schemaData.cache = {
        enabled: true,
        filePath: cachePath,
        note: 'Table schema cached for historical comparison and analysis'
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(schemaData, null, 2)
        }
      ]
    };
  }

  private async getDatabaseOverview(connection: mysql.Connection, databaseName: string | undefined, includeRelationships: boolean, hostName?: string) {
    // Check cache first for database overview (TTL: 2 hours)
    const cacheKey = `overview-${includeRelationships}`;
    const cached = await this.readFromCache(
      'database-overview',
      'schema-snapshots',
      hostName,
      databaseName,
      cacheKey,
      2 // 2 hour TTL for database overviews
    );
    
    if (cached) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ...cached.data,
              cache: cached.cacheInfo
            }, null, 2)
          }
        ]
      };
    }

    const [tables] = await connection.execute('SHOW TABLES');
    
    if (!includeRelationships) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ tables }, null, 2)
          }
        ]
      };
    }

    const [relationships] = await connection.execute(`
      SELECT 
        TABLE_NAME as from_table,
        COLUMN_NAME as from_column,
        REFERENCED_TABLE_NAME as to_table,
        REFERENCED_COLUMN_NAME as to_column,
        CONSTRAINT_NAME
      FROM information_schema.KEY_COLUMN_USAGE 
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
    `, [databaseName || this.getHostConfig(hostName).database]);

    const [tableSizes] = await connection.execute(`
      SELECT 
        table_name,
        table_rows,
        ROUND(((data_length + index_length) / 1024 / 1024), 2) AS size_mb
      FROM information_schema.TABLES 
      WHERE table_schema = ?
      ORDER BY (data_length + index_length) DESC
    `, [databaseName || this.getHostConfig(hostName).database]);

    const overviewData: any = {
      database: databaseName || this.getHostConfig(hostName).database,
      tables,
      tableSizes,
      relationships,
      relationshipGraph: this.buildRelationshipGraph(relationships as any[])
    };

    // Cache the database overview
    const cachePath = await this.saveToCache(
      overviewData,
      'database-overview',
      `schema-snapshots`,
      hostName,
      databaseName,
      'full-overview'
    );

    if (cachePath) {
      overviewData.cache = {
        enabled: true,
        filePath: cachePath,
        note: 'Database overview cached for comprehensive analysis'
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(overviewData, null, 2)
        }
      ]
    };
  }

  private buildRelationshipGraph(relationships: any[]) {
    const graph: { [key: string]: any } = {};
    
    for (const rel of relationships) {
      if (!graph[rel.from_table]) {
        graph[rel.from_table] = { references: [], referencedBy: [] };
      }
      if (!graph[rel.to_table]) {
        graph[rel.to_table] = { references: [], referencedBy: [] };
      }
      
      graph[rel.from_table].references.push({
        table: rel.to_table,
        column: rel.to_column,
        through: rel.from_column
      });
      
      graph[rel.to_table].referencedBy.push({
        table: rel.from_table,
        column: rel.from_column,
        through: rel.to_column
      });
    }
    
    return graph;
  }

  private async handleAnalyzeTables(args: any) {
    const connection = await this.createConnection(args.host);
    const { tables, analysis_type = 'relationships' } = args;
    
    if (!Array.isArray(tables) || tables.length === 0) {
      throw new Error('Tables array is required and cannot be empty');
    }

    switch (analysis_type) {
      case 'relationships':
        return await this.analyzeTableRelationships(connection, tables, args.host);
      case 'user_behavior':
        return await this.analyzeUserBehaviorPatterns(connection, tables);
      case 'data_flow':
        return await this.analyzeDataFlow(connection, tables);
      default:
        throw new Error(`Unknown analysis type: ${analysis_type}`);
    }
  }

  private async analyzeTableRelationships(connection: mysql.Connection, tables: string[], hostName?: string) {
    const relationships: any[] = [];
    const tableInfo: any = {};
    
    for (const table of tables) {
      const [columns] = await connection.execute('DESCRIBE ??', [table]);
      const [foreignKeys] = await connection.execute(`
        SELECT 
          COLUMN_NAME,
          REFERENCED_TABLE_NAME,
          REFERENCED_COLUMN_NAME,
          CONSTRAINT_NAME
        FROM information_schema.KEY_COLUMN_USAGE 
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      `, [this.getHostConfig().database, table]);

      const [rowCount] = await connection.execute(`SELECT COUNT(*) as total FROM ??`, [table]) as any;
      
      tableInfo[table] = {
        columns: columns,
        foreignKeys: foreignKeys,
        rowCount: rowCount[0]?.total || 0
      };
    }

    // Analyze join patterns
    const joinSuggestions = this.suggestOptimalJoins(tableInfo, tables);
    
    const analysisData: any = {
      analysisType: 'relationships',
      tables: tableInfo,
      joinSuggestions,
      queryRecommendations: this.generateQueryRecommendations(tableInfo, 'relationships')
    };

    // Cache the relationship analysis
    const cachePath = await this.saveToCache(
      analysisData,
      'table-relationships',
      `reports/relationship-analysis`,
      hostName,
      undefined,
      `tables-${tables.join('_')}`
    );

    if (cachePath) {
      analysisData.cache = {
        enabled: true,
        filePath: cachePath,
        note: 'Table relationship analysis cached for cross-reference'
      };
    }
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(analysisData, null, 2)
        }
      ]
    };
  }

  private async analyzeUserBehaviorPatterns(connection: mysql.Connection, tables: string[]) {
    const analysis: any = { tables: {}, patterns: [], recommendations: [] };
    
    for (const table of tables) {
      const [columns] = await connection.execute('DESCRIBE ??', [table]);
      const [sample] = await connection.execute(`SELECT * FROM ?? LIMIT 50`, [table]);
      
      // Identify potential user-related columns
      const userColumns = this.identifyUserColumns(columns as any[]);
      const timeColumns = this.identifyTimeColumns(columns as any[]);
      const behaviorColumns = this.identifyBehaviorColumns(columns as any[], sample as any[]);
      
      analysis.tables[table] = {
        columns: columns,
        userColumns,
        timeColumns,
        behaviorColumns,
        sampleData: sample
      };
    }
    
    // Generate user behavior analysis patterns
    analysis.patterns = this.identifyBehaviorPatterns(analysis.tables);
    analysis.recommendations = this.generateQueryRecommendations(analysis.tables, 'user_behavior');
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            analysisType: 'user_behavior',
            ...analysis
          }, null, 2)
        }
      ]
    };
  }

  private async analyzeDataFlow(connection: mysql.Connection, tables: string[]) {
    const flow: any = { tables: {}, dataFlow: [], recommendations: [] };
    
    for (const table of tables) {
      const [columns] = await connection.execute('DESCRIBE ??', [table]);
      const [foreignKeys] = await connection.execute(`
        SELECT 
          COLUMN_NAME,
          REFERENCED_TABLE_NAME,
          REFERENCED_COLUMN_NAME
        FROM information_schema.KEY_COLUMN_USAGE 
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      `, [this.getHostConfig().database, table]);
      
      const [referencedBy] = await connection.execute(`
        SELECT 
          TABLE_NAME as referencing_table,
          COLUMN_NAME as referencing_column
        FROM information_schema.KEY_COLUMN_USAGE 
        WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?
      `, [this.getHostConfig().database, table]);

      flow.tables[table] = {
        columns,
        foreignKeys,
        referencedBy
      };
    }
    
    flow.dataFlow = this.traceDataFlow(flow.tables);
    flow.recommendations = this.generateQueryRecommendations(flow.tables, 'data_flow');
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            analysisType: 'data_flow',
            ...flow
          }, null, 2)
        }
      ]
    };
  }

  private identifyUserColumns(columns: any[]): string[] {
    const userKeywords = ['user', 'customer', 'account', 'person', 'member', 'client'];
    return columns
      .filter(col => userKeywords.some(keyword => 
        col.Field.toLowerCase().includes(keyword)))
      .map(col => col.Field);
  }

  private identifyTimeColumns(columns: any[]): string[] {
    const timeKeywords = ['time', 'date', 'created', 'updated', 'timestamp', 'at'];
    return columns
      .filter(col => 
        col.Type.toLowerCase().includes('timestamp') ||
        col.Type.toLowerCase().includes('datetime') ||
        col.Type.toLowerCase().includes('date') ||
        timeKeywords.some(keyword => col.Field.toLowerCase().includes(keyword)))
      .map(col => col.Field);
  }

  private identifyBehaviorColumns(columns: any[], sampleData: any[]): any[] {
    const behaviorKeywords = ['action', 'event', 'activity', 'status', 'type', 'category'];
    const behaviorCols = columns.filter(col => 
      behaviorKeywords.some(keyword => col.Field.toLowerCase().includes(keyword)));
    
    return behaviorCols.map(col => {
      const values = sampleData.map(row => row[col.Field]).filter(v => v !== null);
      return {
        column: col.Field,
        dataType: col.Type,
        sampleValues: [...new Set(values)].slice(0, 10),
        uniqueCount: new Set(values).size
      };
    });
  }

  private suggestOptimalJoins(tableInfo: any, tables: string[]): any[] {
    const suggestions: any[] = [];
    
    for (let i = 0; i < tables.length; i++) {
      for (let j = i + 1; j < tables.length; j++) {
        const table1 = tables[i];
        const table2 = tables[j];
        
        // Check for direct foreign key relationships
        const fk1 = tableInfo[table1].foreignKeys.find((fk: any) => 
          fk.REFERENCED_TABLE_NAME === table2);
        const fk2 = tableInfo[table2].foreignKeys.find((fk: any) => 
          fk.REFERENCED_TABLE_NAME === table1);
        
        if (fk1) {
          suggestions.push({
            from: table1,
            to: table2,
            joinType: 'INNER JOIN',
            condition: `${table1}.${fk1.COLUMN_NAME} = ${table2}.${fk1.REFERENCED_COLUMN_NAME}`,
            relationship: 'foreign_key'
          });
        } else if (fk2) {
          suggestions.push({
            from: table2,
            to: table1,
            joinType: 'INNER JOIN',
            condition: `${table2}.${fk2.COLUMN_NAME} = ${table1}.${fk2.REFERENCED_COLUMN_NAME}`,
            relationship: 'foreign_key'
          });
        } else {
          // Check for common column names that might indicate relationships
          const commonCols = this.findCommonColumns(
            tableInfo[table1].columns,
            tableInfo[table2].columns
          );
          if (commonCols.length > 0) {
            suggestions.push({
              from: table1,
              to: table2,
              joinType: 'INNER JOIN',
              condition: commonCols.map(col => `${table1}.${col} = ${table2}.${col}`).join(' AND '),
              relationship: 'inferred',
              commonColumns: commonCols
            });
          }
        }
      }
    }
    
    return suggestions;
  }

  private findCommonColumns(cols1: any[], cols2: any[]): string[] {
    const names1 = cols1.map(c => c.Field.toLowerCase());
    const names2 = cols2.map(c => c.Field.toLowerCase());
    return names1.filter(name => names2.includes(name));
  }

  private identifyBehaviorPatterns(tables: any): any[] {
    const patterns = [];
    
    for (const [tableName, tableData] of Object.entries(tables) as any[]) {
      if (tableData.userColumns.length > 0 && tableData.timeColumns.length > 0) {
        patterns.push({
          pattern: 'user_timeline',
          table: tableName,
          description: 'Track user actions over time',
          suggestedQuery: `SELECT ${tableData.userColumns[0]}, ${tableData.timeColumns[0]}, COUNT(*) as action_count 
                          FROM ${tableName} 
                          GROUP BY ${tableData.userColumns[0]}, DATE(${tableData.timeColumns[0]})
                          ORDER BY ${tableData.timeColumns[0]} DESC`
        });
      }
      
      if (tableData.behaviorColumns.length > 0) {
        patterns.push({
          pattern: 'behavior_analysis',
          table: tableName,
          description: 'Analyze user behavior patterns',
          suggestedQuery: `SELECT ${tableData.behaviorColumns[0].column}, COUNT(*) as frequency
                          FROM ${tableName}
                          GROUP BY ${tableData.behaviorColumns[0].column}
                          ORDER BY frequency DESC`
        });
      }
    }
    
    return patterns;
  }

  private traceDataFlow(tables: any): any[] {
    const flows = [];
    
    for (const [tableName, tableData] of Object.entries(tables) as any[]) {
      if (tableData.foreignKeys && tableData.foreignKeys.length > 0) {
        for (const fk of tableData.foreignKeys) {
          flows.push({
            from: fk.REFERENCED_TABLE_NAME,
            to: tableName,
            relationship: 'parent_to_child',
            column: fk.COLUMN_NAME
          });
        }
      }
    }
    
    return flows;
  }

  private generateQueryRecommendations(tableInfo: any, analysisType: string): any[] {
    const recommendations = [];
    
    if (analysisType === 'user_behavior') {
      recommendations.push({
        title: 'User Activity Over Time',
        description: 'Track how user engagement changes over time periods',
        example: 'SELECT DATE(created_at) as date, COUNT(DISTINCT user_id) as active_users FROM events GROUP BY DATE(created_at)'
      });
      
      recommendations.push({
        title: 'User Funnel Analysis',
        description: 'Analyze user progression through different stages',
        example: 'WITH funnel AS (SELECT user_id, MIN(created_at) as first_action, MAX(created_at) as last_action FROM events GROUP BY user_id) SELECT COUNT(*) FROM funnel'
      });
    } else if (analysisType === 'relationships') {
      recommendations.push({
        title: 'Cross-Table User Analysis',
        description: 'Join related tables to get comprehensive user insights',
        example: 'SELECT u.*, COUNT(e.id) as event_count FROM users u LEFT JOIN events e ON u.id = e.user_id GROUP BY u.id'
      });
    }
    
    return recommendations;
  }

  private async handleInventory(args: any) {
    const { refresh = false, host } = args;
    
    // Refresh inventory if requested
    if (refresh) {
      console.error('Refreshing host inventory...');
      const hostsToRefresh = host ? [host] : Array.from(this.hostConfigs.keys());
      
      for (const hostName of hostsToRefresh) {
        await this.scanHostDatabases(hostName);
      }
    }
    
    // Get inventory data
    let inventoryData;
    
    if (host) {
      const inventory = this.hostInventory.get(host);
      if (!inventory) {
        throw new Error(`Host '${host}' not found. Available hosts: ${this.getAvailableHosts().join(', ')}`);
      }
      
      inventoryData = {
        requestedHost: host,
        inventory: {
          [host]: {
            name: inventory.name,
            status: inventory.status,
            databases: inventory.databases,
            lastScanned: inventory.lastScanned?.toISOString(),
            connectionTest: inventory.connectionTest,
            error: inventory.error,
            isDefault: inventory.config.isDefault,
            classification: inventory.classification,
            federationCapabilities: inventory.federationCapabilities
          }
        }
      };
    } else {
      // Return all hosts
      const allInventory = Object.fromEntries(
        Array.from(this.hostInventory.entries()).map(([name, inventory]) => [
          name,
          {
            name: inventory.name,
            status: inventory.status,
            databases: inventory.databases,
            lastScanned: inventory.lastScanned?.toISOString(),
            connectionTest: inventory.connectionTest,
            error: inventory.error,
            isDefault: inventory.config.isDefault,
            host: inventory.config.host,
            port: inventory.config.port,
            user: inventory.config.user,
            classification: inventory.classification,
            federationCapabilities: inventory.federationCapabilities
          }
        ])
      );
      
      inventoryData = {
        summary: {
          totalHosts: this.hostInventory.size,
          connectedHosts: Array.from(this.hostInventory.values()).filter(inv => inv.status === 'connected').length,
          errorHosts: Array.from(this.hostInventory.values()).filter(inv => inv.status === 'error').length,
          totalDatabases: Array.from(this.hostInventory.values()).reduce((sum, inv) => sum + inv.databases.length, 0),
          lastRefresh: new Date().toISOString()
        },
        crossHostCapabilities: {
          canCombineData: true,
          supportedOperations: ['cross_host_queries', 'multi_host_analysis', 'data_federation'],
          recommendations: this.generateCrossHostRecommendations()
        },
        inventory: allInventory
      };
    }
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(inventoryData, null, 2)
        }
      ]
    };
  }

  private generateCrossHostRecommendations(): string[] {
    const recommendations = [];
    const connectedHosts = Array.from(this.hostInventory.values()).filter(inv => inv.status === 'connected');
    
    if (connectedHosts.length > 1) {
      // Business system classification insights
      const systemTypes = connectedHosts.map(inv => inv.classification?.type).filter(Boolean);
      const uniqueTypes = [...new Set(systemTypes)];
      
      if (uniqueTypes.length > 1) {
        recommendations.push(`🏢 Enterprise data federation ready: ${uniqueTypes.length} different business systems detected (${uniqueTypes.join(', ')})`);
        
        // Specific business intelligence recommendations based on system combinations
        if (systemTypes.includes('crm') && systemTypes.includes('ecommerce')) {
          recommendations.push('💰 CRM + E-commerce detected: Perfect for customer journey analysis, lead-to-revenue tracking, and sales funnel optimization.');
        }
        
        if (systemTypes.includes('marketing') && systemTypes.includes('crm')) {
          recommendations.push('📧 Marketing + CRM integration: Analyze campaign effectiveness, lead quality, and marketing attribution.');
        }
        
        if (systemTypes.includes('support') && (systemTypes.includes('crm') || systemTypes.includes('ecommerce'))) {
          recommendations.push('🎧 Support system integration: Track customer satisfaction, support impact on retention, and service quality metrics.');
        }
        
        if (systemTypes.includes('erp') && systemTypes.includes('ecommerce')) {
          recommendations.push('📊 ERP + E-commerce integration: Complete business view from procurement to sales, inventory optimization, and financial reporting.');
        }
      }
      
      // Federation capability insights
      const federationPairs = [];
      for (const host1 of connectedHosts) {
        if (host1.federationCapabilities?.canJoinWith) {
          for (const host2Name of host1.federationCapabilities.canJoinWith) {
            const host2 = connectedHosts.find(h => h.name === host2Name);
            if (host2) {
              federationPairs.push(`${host1.name} ↔ ${host2Name}`);
            }
          }
        }
      }
      
      if (federationPairs.length > 0) {
        recommendations.push(`🔗 Data federation ready: ${federationPairs.join(', ')} can be joined using shared identifiers.`);
        
        // Find most common shared identifiers
        const allSharedIds = connectedHosts.flatMap(h => h.federationCapabilities?.sharedIdentifiers || []);
        const idCounts = allSharedIds.reduce((acc, id) => { acc[id] = (acc[id] || 0) + 1; return acc; }, {} as any);
        const topIds = Object.entries(idCounts)
          .filter(([, count]) => (count as number) > 1)
          .sort(([, a], [, b]) => (b as number) - (a as number))
          .slice(0, 3)
          .map(([id]) => id);
          
        if (topIds.length > 0) {
          recommendations.push(`🔑 Primary join keys available: ${topIds.join(', ')} - use these for cross-source customer/user analysis.`);
        }
      }
      
      // Data volume insights
      const totalRecords = connectedHosts.reduce((sum, inv) => sum + (inv.classification?.estimatedRecords || 0), 0);
      if (totalRecords > 1000000) {
        recommendations.push(`📈 Large dataset federation: ${totalRecords.toLocaleString()} total records across all sources - consider query optimization and result limiting.`);
      }
      
      // Business use case recommendations
      recommendations.push('🎯 Recommended federation use cases:');
      recommendations.push('  • 360° customer view: Combine customer data from all touchpoints');
      recommendations.push('  • Revenue attribution: Track customer journey from lead to purchase');
      recommendations.push('  • Operational efficiency: Identify bottlenecks across business processes');
      recommendations.push('  • Data consistency auditing: Compare data integrity across systems');
    }
    
    return recommendations;
  }

  private async handleCrossHostQuery(args: any) {
    const { queries, combine_strategy = 'separate', analysis_focus = 'data_consistency' } = args;
    
    if (!Array.isArray(queries) || queries.length === 0) {
      throw new Error('At least one query is required');
    }
    
    const results: any[] = [];
    const errors: any[] = [];
    const executionStats = {
      startTime: Date.now(),
      totalQueries: queries.length,
      successfulQueries: 0,
      failedQueries: 0,
      hostsUsed: new Set<string>()
    };
    
    // Execute queries on each host
    for (let i = 0; i < queries.length; i++) {
      const queryConfig = queries[i];
      const { host, database, query, alias } = queryConfig;
      
      try {
        // Validate host exists
        const hostInventory = this.hostInventory.get(host);
        if (!hostInventory) {
          throw new Error(`Host '${host}' not found. Available hosts: ${this.getAvailableHosts().join(', ')}`);
        }
        
        if (hostInventory.status !== 'connected') {
          throw new Error(`Host '${host}' is not connected (status: ${hostInventory.status})`);
        }
        
        // Validate query is read-only
        if (!this.isReadOnlyQuery(query)) {
          throw new Error(`Only read-only queries are allowed. Query ${i + 1} contains write operations.`);
        }
        
        const connection = await this.createConnection(host, database);
        const queryStartTime = Date.now();
        const [rows] = await connection.execute(query);
        const queryEndTime = Date.now();
        
        executionStats.hostsUsed.add(host);
        executionStats.successfulQueries++;
        
        results.push({
          index: i,
          alias: alias || `query_${i + 1}`,
          host,
          database: database || hostInventory.config.database || null,
          query,
          data: rows,
          metadata: {
            rowCount: Array.isArray(rows) ? rows.length : 0,
            executionTime: queryEndTime - queryStartTime,
            timestamp: new Date().toISOString()
          }
        });
        
      } catch (error) {
        executionStats.failedQueries++;
        errors.push({
          index: i,
          host,
          database,
          query,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
    
    const hostsUsedArray = Array.from(executionStats.hostsUsed);
    const totalExecutionTime = Date.now() - executionStats.startTime;
    
    // Combine results based on strategy
    let combinedResults;
    switch (combine_strategy) {
      case 'union':
        combinedResults = this.unionResults(results);
        break;
      case 'comparison':
        combinedResults = this.compareResults(results, analysis_focus);
        break;
      case 'correlation':
        combinedResults = this.correlateResults(results, analysis_focus);
        break;
      default: // 'separate'
        combinedResults = { strategy: 'separate', results };
    }
    
    const crossHostAnalysis = {
      executionSummary: {
        ...executionStats,
        totalExecutionTime,
        hostsUsed: hostsUsedArray
      },
      combineStrategy: combine_strategy,
      analysisFocus: analysis_focus,
      results: combinedResults,
      errors: errors.length > 0 ? errors : undefined,
      insights: this.generateCrossHostInsights(results, analysis_focus),
      recommendations: this.generateCrossHostQueryRecommendations(results, analysis_focus)
    };
    
    // Cache the cross-host analysis
    const cachePath = await this.saveToCache(
      crossHostAnalysis,
      'cross-host-query',
      'reports/cross-host-analysis',
      'multi-host',
      undefined,
      `${combine_strategy}-${Date.now()}`
    );
    
    if (cachePath) {
      (crossHostAnalysis as any).cache = {
        enabled: true,
        filePath: cachePath,
        note: 'Cross-host query analysis cached for future reference'
      };
    }
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(crossHostAnalysis, null, 2)
        }
      ]
    };
  }
  
  private unionResults(results: any[]): any {
    if (results.length === 0) return { strategy: 'union', combinedData: [] };
    
    // Simple union - combine all data arrays
    const combinedData = results.reduce((acc, result) => {
      if (Array.isArray(result.data)) {
        return acc.concat(result.data.map((row: any) => ({ ...row, _source_host: result.host, _source_alias: result.alias })));
      }
      return acc;
    }, []);
    
    return {
      strategy: 'union',
      combinedData,
      totalRows: combinedData.length,
      sources: results.map(r => ({ host: r.host, alias: r.alias, rowCount: r.metadata.rowCount }))
    };
  }
  
  private compareResults(results: any[], focus: string): any {
    const comparison = {
      strategy: 'comparison',
      focus,
      results: results.map(r => ({
        host: r.host,
        alias: r.alias,
        rowCount: r.metadata.rowCount,
        executionTime: r.metadata.executionTime,
        sampleData: Array.isArray(r.data) ? r.data.slice(0, 3) : []
      })),
      analysis: {
        rowCountComparison: results.map(r => ({ host: r.host, rows: r.metadata.rowCount })),
        performanceComparison: results.map(r => ({ host: r.host, executionTime: r.metadata.executionTime }))
      }
    };
    
    if (focus === 'performance') {
      (comparison.analysis as any).performanceInsights = this.analyzePerformanceDifferences(results);
    }
    
    return comparison;
  }
  
  private correlateResults(results: any[], focus: string): any {
    // Basic correlation analysis
    const correlation = {
      strategy: 'correlation',
      focus,
      patterns: [],
      insights: []
    };
    
    if (results.length >= 2) {
      // Look for common columns across results
      const columnSets = results.map(r => {
        if (Array.isArray(r.data) && r.data.length > 0) {
          return Object.keys(r.data[0]);
        }
        return [];
      });
      
      if (columnSets.length > 1) {
        const commonColumns = columnSets[0].filter(col => 
          columnSets.every(set => set.includes(col))
        );
        
        (correlation as any).commonColumns = commonColumns;
        (correlation as any).insights.push(`Found ${commonColumns.length} common columns across hosts: ${commonColumns.join(', ')}`);
      }
    }
    
    return correlation;
  }
  
  private analyzePerformanceDifferences(results: any[]): string[] {
    const insights = [];
    const times = results.map(r => r.metadata.executionTime);
    const avgTime = times.reduce((sum, time) => sum + time, 0) / times.length;
    
    const slowHost = results.reduce((prev, current) => 
      (prev.metadata.executionTime > current.metadata.executionTime) ? prev : current
    );
    
    const fastHost = results.reduce((prev, current) => 
      (prev.metadata.executionTime < current.metadata.executionTime) ? prev : current
    );
    
    if (slowHost.metadata.executionTime > avgTime * 1.5) {
      insights.push(`Host '${slowHost.host}' is significantly slower (${slowHost.metadata.executionTime}ms vs ${avgTime.toFixed(0)}ms avg)`);
    }
    
    if (fastHost.metadata.executionTime < avgTime * 0.5) {
      insights.push(`Host '${fastHost.host}' shows excellent performance (${fastHost.metadata.executionTime}ms)`);
    }
    
    return insights;
  }
  
  private generateCrossHostInsights(results: any[], focus: string): string[] {
    const insights = [];
    
    if (results.length > 1) {
      const hostsUsed = results.map(r => r.host);
      const hostClassifications = hostsUsed.map(host => {
        const inventory = this.hostInventory.get(host);
        return inventory?.classification?.type || 'unknown';
      });
      
      insights.push(`🔗 Federated query across ${hostsUsed.length} business systems: ${hostsUsed.map((host, i) => `${host} (${hostClassifications[i]})`).join(', ')}`);
      
      const totalRows = results.reduce((sum, r) => sum + r.metadata.rowCount, 0);
      insights.push(`📊 Combined enterprise dataset: ${totalRows.toLocaleString()} total records federated across business systems`);
      
      // Business-specific insights based on system types involved
      const systemTypes = [...new Set(hostClassifications.filter(t => t !== 'unknown'))];
      if (systemTypes.length > 1) {
        insights.push(`💼 Multi-system analysis: Combining data from ${systemTypes.join(' + ')} systems enables comprehensive business intelligence`);
      }
      
      if (focus === 'data_consistency') {
        // Analyze data consistency across business systems
        const rowCounts = results.map(r => r.metadata.rowCount);
        const maxRows = Math.max(...rowCounts);
        const minRows = Math.min(...rowCounts);
        
        if (maxRows > minRows * 2) {
          insights.push(`⚠️  Data volume variance detected: ${maxRows.toLocaleString()} vs ${minRows.toLocaleString()} records - may indicate data sync issues between systems`);
        } else {
          insights.push('✅ Data volumes are consistent across business systems - good data integration');
        }
        
        // Performance insights across systems
        const performanceTimes = results.map(r => ({ host: r.host, time: r.metadata.executionTime }));
        const avgTime = performanceTimes.reduce((sum, p) => sum + p.time, 0) / performanceTimes.length;
        const slowSystems = performanceTimes.filter(p => p.time > avgTime * 1.5);
        
        if (slowSystems.length > 0) {
          insights.push(`🐌 Performance bottlenecks: ${slowSystems.map(s => s.host).join(', ')} showing slower response times - consider system optimization`);
        }
      }
      
      if (focus === 'user_behavior') {
        insights.push('👥 Cross-system user behavior analysis ready - ideal for 360° customer journey mapping and attribution modeling');
      }
      
      if (focus === 'business_metrics') {
        insights.push('📈 Multi-source business intelligence: Perfect for comprehensive KPI reporting and cross-functional analytics');
      }
    }
    
    return insights;
  }
  
  private generateCrossHostQueryRecommendations(results: any[], focus: string): string[] {
    const recommendations = [];
    
    if (results.length > 1) {
      const hostsUsed = results.map(r => r.host);
      const systemTypes = hostsUsed.map(host => {
        const inventory = this.hostInventory.get(host);
        return inventory?.classification?.type;
      }).filter(Boolean);
      
      // Data combination strategies
      recommendations.push('🔗 Federation Strategies:');
      recommendations.push('  • Use correlation strategy to find relationships between business systems');
      recommendations.push('  • Use comparison strategy to identify data consistency issues');
      recommendations.push('  • Use union strategy to create comprehensive business datasets');
      
      // Business-specific recommendations
      if (focus === 'user_behavior' || systemTypes.some(t => ['crm', 'ecommerce', 'marketing'].includes(t!))) {
        recommendations.push('👥 Customer Intelligence Recommendations:');
        recommendations.push('  • JOIN customer data using email, customer_id, or user_id across systems');
        recommendations.push('  • Create customer lifetime value by combining CRM leads, e-commerce purchases, and support interactions');
        recommendations.push('  • Track customer journey from marketing campaign → lead → opportunity → purchase → support');
        recommendations.push('  • Build customer segmentation using cross-system behavioral data');
      }
      
      if (focus === 'business_metrics' || systemTypes.some(t => ['erp', 'ecommerce', 'warehouse'].includes(t!))) {
        recommendations.push('📊 Business Intelligence Recommendations:');
        recommendations.push('  • Create executive dashboards combining financial (ERP) + sales (e-commerce) + operational data');
        recommendations.push('  • Build end-to-end process analytics from procurement → inventory → sales → finance');
        recommendations.push('  • Implement real-time business health monitoring across all systems');
        recommendations.push('  • Use time-based partitioning (daily/monthly) for historical trend analysis');
      }
      
      if (systemTypes.includes('support')) {
        recommendations.push('🎧 Customer Experience Recommendations:');
        recommendations.push('  • Correlate support ticket volume with sales/marketing activities');
        recommendations.push('  • Analyze customer health score combining purchase history + support interactions');
        recommendations.push('  • Track resolution efficiency impact on customer retention');
      }
      
      // Technical optimization recommendations
      const totalRows = results.reduce((sum, r) => sum + r.metadata.rowCount, 0);
      if (totalRows > 100000) {
        recommendations.push('⚡ Performance Optimization:');
        recommendations.push('  • Use LIMIT clauses for large dataset exploration');
        recommendations.push('  • Consider time-based filtering (last 30/90 days) for faster queries');
        recommendations.push('  • Use aggregate functions (COUNT, SUM, AVG) instead of retrieving all records');
        recommendations.push('  • Cache frequently accessed cross-system reports');
      }
      
      // Data quality recommendations
      recommendations.push('🔍 Data Quality Best Practices:');
      recommendations.push('  • Validate shared identifiers (customer_id, email) exist in all systems');
      recommendations.push('  • Check for data freshness discrepancies between systems');
      recommendations.push('  • Monitor for duplicate records when combining datasets');
      recommendations.push('  • Use consistent date/time formats across system queries');
    }
    
    return recommendations;
  }

  private async handleDiscoverAnalytics(args: any) {
    const connection = await this.createConnection(args.host);
    const { 
      databases, 
      focus_area = 'general', 
      include_recommendations = true,
      cross_database_analysis = true,
      detail_level = 'summary',
      max_tables_per_db = 20,
      sample_data_limit = 3,
      page = 1,
      page_size = 5
    } = args;
    
    // Check cache first for discovery analytics (TTL: 4 hours for expensive operations)
    const sortedDbs = databases ? databases.slice().sort().join('-') : 'all';
    const cacheKey = `${focus_area}-${detail_level}-p${page}_${page_size}-t${max_tables_per_db}-s${sample_data_limit}`;
    
    const cached = await this.readFromCache(
      'database-discovery',
      'reports/discovery-reports',
      args.host,
      sortedDbs,
      cacheKey,
      4 // 4 hour TTL for expensive discovery operations
    );
    
    if (cached) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ...cached.data,
              cache: cached.cacheInfo
            }, null, 2)
          }
        ]
      };
    }
    
    // First, discover available databases if not specified
    let targetDatabases = databases;
    if (!targetDatabases) {
      const dbQuery = `SHOW DATABASES`;
      const [dbResult] = await connection.execute(dbQuery);
      targetDatabases = (dbResult as any[])
        .map(row => row.Database)
        .filter(db => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(db));
    }

    // Calculate pagination
    const totalDatabases = targetDatabases.length;
    const totalPages = Math.ceil(totalDatabases / page_size);
    const startIndex = (page - 1) * page_size;
    const endIndex = Math.min(startIndex + page_size, totalDatabases);
    const pagedDatabases = targetDatabases.slice(startIndex, endIndex);

    const discovery: any = {
      executedQueries: [] as string[],
      server: { host: this.getHostConfig(args.host).host, port: this.getHostConfig(args.host).port },
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        pageSize: page_size,
        totalDatabases: totalDatabases,
        currentPageDatabases: pagedDatabases.length,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
        nextPageCall: page < totalPages ? {
          tool: 'mysql_discover_analytics',
          parameters: { ...args, page: page + 1 }
        } : null
      },
      allDatabases: targetDatabases,
      analyzedDatabases: pagedDatabases,
      focusArea: focus_area,
      discoveryTimestamp: new Date().toISOString(),
      databases: {} as any,
      crossDatabaseInsights: [] as any[],
      analyticsInsights: [] as any[],
      recommendedQueries: [] as any[]
    };

    discovery.executedQueries.push(`SHOW DATABASES`);

    // Analyze each database in the current page
    for (const dbName of pagedDatabases) {
      const dbAnalysis = await this.analyzeSingleDatabase(
        connection, 
        dbName, 
        focus_area, 
        detail_level, 
        max_tables_per_db, 
        sample_data_limit
      );
      discovery.databases[dbName] = dbAnalysis.database;
      discovery.executedQueries.push(...dbAnalysis.executedQueries);
    }

    // Cross-database analysis
    if (cross_database_analysis && targetDatabases.length > 1) {
      discovery.crossDatabaseInsights = this.analyzeCrossDatabasePatterns(discovery.databases);
    }

    // Generate insights and recommendations
    if (include_recommendations) {
      discovery.analyticsInsights = this.generateMultiDatabaseInsights(discovery.databases, focus_area);
      discovery.recommendedQueries = this.generateMultiDatabaseQueries(discovery.databases, focus_area);
    }

    // Cache the discovery analysis
    const cachePath = await this.saveToCache(
      discovery,
      'database-discovery',
      `reports/discovery-reports`,
      args.host,
      sortedDbs,
      cacheKey
    );

    if (cachePath) {
      discovery.cache = {
        enabled: true,
        filePath: cachePath,
        note: 'Complete database discovery analysis cached for comprehensive reporting'
      };
    }

    // Check response size and provide guidance if still large
    const responseText = JSON.stringify(discovery, null, 2);
    const approximateTokens = Math.ceil(responseText.length / 4); // Rough token estimate
    
    if (approximateTokens > 20000) {
      // Add size warning but return full data
      (discovery as any).responseInfo = {
        approximateTokens,
        sizeWarning: "Large response detected. Consider using smaller page_size or detail_level='summary' for faster processing.",
        suggestions: [
          `Use page_size=${Math.max(1, Math.floor(page_size / 2))} for smaller chunks`,
          "Use detail_level='summary' for overview only",
          "Filter to specific databases with 'databases' parameter"
        ]
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(discovery, null, 2)
        }
      ]
    };
  }

  private classifyTableIntelligently(tableName: string, columns: any[], sampleData: any[], focusArea: string) {
    const analysis = {
      tableType: 'unknown',
      confidence: 0,
      userColumns: [] as string[],
      timeColumns: [] as string[],
      behaviorColumns: [] as string[],
      dimensionColumns: [] as string[],
      metricColumns: [] as string[],
      identifierColumns: [] as string[],
      relationships: {
        isFactTable: false,
        isDimensionTable: false,
        isUserTable: false,
        isEventTable: false,
        isLookupTable: false
      }
    };

    for (const col of columns) {
      const colName = col.COLUMN_NAME.toLowerCase();
      const dataType = col.DATA_TYPE.toLowerCase();
      
      // Identify column types intelligently
      if (colName.includes('id') && (col.COLUMN_KEY === 'PRI' || col.EXTRA.includes('auto_increment'))) {
        analysis.identifierColumns.push(col.COLUMN_NAME);
      }
      
      if (['user', 'customer', 'account', 'person', 'member', 'client'].some(k => colName.includes(k))) {
        analysis.userColumns.push(col.COLUMN_NAME);
      }
      
      if (dataType.includes('timestamp') || dataType.includes('datetime') || dataType.includes('date') ||
          ['created', 'updated', 'modified', 'deleted', 'time', 'date'].some(k => colName.includes(k))) {
        analysis.timeColumns.push(col.COLUMN_NAME);
      }
      
      if (['action', 'event', 'activity', 'status', 'type', 'category', 'state'].some(k => colName.includes(k))) {
        analysis.behaviorColumns.push(col.COLUMN_NAME);
      }
      
      if (['count', 'amount', 'total', 'sum', 'avg', 'price', 'cost', 'revenue', 'quantity'].some(k => colName.includes(k))) {
        analysis.metricColumns.push(col.COLUMN_NAME);
      }
      
      if (['name', 'title', 'description', 'label', 'category'].some(k => colName.includes(k))) {
        analysis.dimensionColumns.push(col.COLUMN_NAME);
      }
    }

    // Determine table type based on analysis
    if (analysis.userColumns.length > 0 && analysis.timeColumns.length === 0) {
      analysis.tableType = 'user_dimension';
      analysis.relationships.isUserTable = true;
      analysis.relationships.isDimensionTable = true;
      analysis.confidence = 0.9;
    } else if (analysis.userColumns.length > 0 && analysis.timeColumns.length > 0 && analysis.behaviorColumns.length > 0) {
      analysis.tableType = 'user_events';
      analysis.relationships.isEventTable = true;
      analysis.relationships.isFactTable = true;
      analysis.confidence = 0.95;
    } else if (analysis.metricColumns.length > analysis.dimensionColumns.length) {
      analysis.tableType = 'fact_table';
      analysis.relationships.isFactTable = true;
      analysis.confidence = 0.8;
    } else if (analysis.dimensionColumns.length > 0 && columns.length < 10) {
      analysis.tableType = 'dimension_table';
      analysis.relationships.isDimensionTable = true;
      analysis.confidence = 0.7;
    } else if (columns.length < 5 && sampleData.length < 100) {
      analysis.tableType = 'lookup_table';
      analysis.relationships.isLookupTable = true;
      analysis.confidence = 0.6;
    }

    return analysis;
  }

  private generateTableInsights(tableName: string, tableInfo: any, columns: any[], sampleData: any[], relationships: any[]) {
    const insights = [];
    
    // Size insights
    if (tableInfo.TABLE_ROWS > 1000000) {
      insights.push(`Large table with ${tableInfo.TABLE_ROWS?.toLocaleString()} rows - consider partitioning strategies`);
    }
    
    // Relationship insights
    const incomingRefs = relationships.filter(r => r.target_table === tableName);
    const outgoingRefs = relationships.filter(r => r.source_table === tableName);
    
    if (incomingRefs.length > 3) {
      insights.push(`Central table with ${incomingRefs.length} incoming relationships - likely a core dimension`);
    }
    
    if (outgoingRefs.length > 5) {
      insights.push(`Highly connected table with ${outgoingRefs.length} foreign keys - potential fact table`);
    }

    // Data quality insights
    const nullableCols = columns.filter(c => c.IS_NULLABLE === 'YES').length;
    if (nullableCols > columns.length * 0.7) {
      insights.push(`High nullable column ratio (${Math.round(nullableCols/columns.length*100)}%) - check data completeness`);
    }

    return insights;
  }

  private generateExpertInsights(tables: any, relationships: any[], focusArea: string) {
    const insights = [];
    
    const tableNames = Object.keys(tables);
    const factTables = tableNames.filter(t => tables[t].analysis.relationships.isFactTable);
    const dimTables = tableNames.filter(t => tables[t].analysis.relationships.isDimensionTable);
    const userTables = tableNames.filter(t => tables[t].analysis.relationships.isUserTable);
    const eventTables = tableNames.filter(t => tables[t].analysis.relationships.isEventTable);

    insights.push({
      category: 'Schema Architecture',
      insight: `Detected ${factTables.length} fact tables, ${dimTables.length} dimension tables`,
      recommendation: factTables.length > 0 ? 'Star schema detected - optimize for analytical queries' : 'Consider creating fact tables for better analytics'
    });

    if (focusArea === 'user_behavior' && userTables.length > 0 && eventTables.length > 0) {
      insights.push({
        category: 'User Analytics Ready',
        insight: `Found user tables (${userTables.join(', ')}) and event tables (${eventTables.join(', ')})`,
        recommendation: 'Perfect setup for user journey analysis, cohort studies, and behavioral segmentation'
      });
    }

    if (relationships.length > 10) {
      insights.push({
        category: 'Complex Schema',
        insight: `${relationships.length} relationships detected`,
        recommendation: 'Use CTEs and proper indexing for multi-table analytical queries'
      });
    }

    return insights;
  }

  private generateExpertQueries(tables: any, relationships: any[], focusArea: string) {
    const queries = [];
    
    const userTables = Object.keys(tables).filter(t => tables[t].analysis.relationships.isUserTable);
    const eventTables = Object.keys(tables).filter(t => tables[t].analysis.relationships.isEventTable);

    if (focusArea === 'user_behavior' && userTables.length > 0 && eventTables.length > 0) {
      const userTable = userTables[0];
      const eventTable = eventTables[0];
      const userIdCol = tables[userTable].analysis.userColumns[0] || 'user_id';
      const timeCol = tables[eventTable].analysis.timeColumns[0] || 'created_at';
      
      queries.push({
        title: 'User Activity Timeline',
        description: 'Track user engagement over time',
        sql: `SELECT 
  DATE(${timeCol}) as activity_date,
  COUNT(DISTINCT ${userIdCol}) as active_users,
  COUNT(*) as total_events
FROM ${eventTable} 
WHERE ${timeCol} >= DATE_SUB(NOW(), INTERVAL 30 DAY)
GROUP BY DATE(${timeCol})
ORDER BY activity_date DESC`,
        useCase: 'Daily active user tracking and engagement trends'
      });

      queries.push({
        title: 'User Behavior Cohort Analysis',
        description: 'Analyze user retention by signup cohort',
        sql: `WITH user_cohorts AS (
  SELECT 
    ${userIdCol},
    DATE_FORMAT(MIN(${timeCol}), '%Y-%m') as signup_month
  FROM ${eventTable}
  GROUP BY ${userIdCol}
),
cohort_activity AS (
  SELECT 
    uc.signup_month,
    DATE_FORMAT(e.${timeCol}, '%Y-%m') as activity_month,
    COUNT(DISTINCT e.${userIdCol}) as active_users
  FROM user_cohorts uc
  JOIN ${eventTable} e ON uc.${userIdCol} = e.${userIdCol}
  GROUP BY uc.signup_month, DATE_FORMAT(e.${timeCol}, '%Y-%m')
)
SELECT 
  signup_month,
  activity_month,
  active_users,
  DATEDIFF(STR_TO_DATE(activity_month, '%Y-%m'), STR_TO_DATE(signup_month, '%Y-%m'))/30 as months_since_signup
FROM cohort_activity
ORDER BY signup_month, activity_month`,
        useCase: 'Understanding user retention patterns over time'
      });
    }

    // Add general analytical queries
    const factTables = Object.keys(tables).filter(t => tables[t].analysis.relationships.isFactTable);
    if (factTables.length > 0) {
      const factTable = factTables[0];
      const timeCol = tables[factTable].analysis.timeColumns[0];
      const metricCol = tables[factTable].analysis.metricColumns[0];
      
      if (timeCol && metricCol) {
        queries.push({
          title: 'Time Series Analysis',
          description: `Analyze ${metricCol} trends over time`,
          sql: `SELECT 
  DATE_FORMAT(${timeCol}, '%Y-%m') as period,
  COUNT(*) as record_count,
  SUM(${metricCol}) as total_${metricCol},
  AVG(${metricCol}) as avg_${metricCol}
FROM ${factTable}
WHERE ${timeCol} >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
GROUP BY DATE_FORMAT(${timeCol}, '%Y-%m')
ORDER BY period`,
          useCase: 'Monthly performance tracking and trend analysis'
        });
      }
    }

    return queries;
  }

  private async analyzeSingleDatabase(
    connection: mysql.Connection, 
    databaseName: string, 
    focusArea: string, 
    detailLevel: string = 'summary',
    maxTables: number = 20,
    sampleDataLimit: number = 3
  ) {
    const analysis = {
      database: {
        name: databaseName,
        tables: {} as any,
        relationships: [] as any[],
        summary: {} as any
      },
      executedQueries: [] as string[]
    };

    // Get all tables for this database (limit for performance)
    const tablesQuery = `
      SELECT 
        t.TABLE_NAME,
        t.ENGINE,
        t.TABLE_ROWS,
        t.DATA_LENGTH,
        t.INDEX_LENGTH,
        t.AUTO_INCREMENT,
        t.CREATE_TIME,
        t.UPDATE_TIME,
        t.TABLE_COMMENT
      FROM information_schema.TABLES t 
      WHERE t.TABLE_SCHEMA = ?
      ORDER BY t.DATA_LENGTH DESC
      LIMIT ?`;
    
    analysis.executedQueries.push(tablesQuery);
    const [tablesResult] = await connection.execute(tablesQuery, [databaseName, maxTables]);
    const tables = tablesResult as any[];

    // Get relationships for this database
    const relationshipsQuery = `
      SELECT 
        kcu.TABLE_NAME as source_table,
        kcu.COLUMN_NAME as source_column,
        kcu.REFERENCED_TABLE_NAME as target_table,
        kcu.REFERENCED_COLUMN_NAME as target_column,
        kcu.CONSTRAINT_NAME,
        rc.UPDATE_RULE,
        rc.DELETE_RULE
      FROM information_schema.KEY_COLUMN_USAGE kcu
      JOIN information_schema.REFERENTIAL_CONSTRAINTS rc 
        ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
      WHERE kcu.TABLE_SCHEMA = ? 
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`;
    
    analysis.executedQueries.push(relationshipsQuery);
    const [relationshipsResult] = await connection.execute(relationshipsQuery, [databaseName]);
    analysis.database.relationships = relationshipsResult as any[];

    // Analyze each table based on detail level
    for (const table of tables) {
      const tableName = table.TABLE_NAME;
      
      let columns: any[] = [];
      let sampleData: any[] = [];
      
      if (detailLevel !== 'summary') {
        // Get columns
        const columnsQuery = `
          SELECT 
            COLUMN_NAME,
            DATA_TYPE,
            IS_NULLABLE,
            COLUMN_KEY,
            COLUMN_DEFAULT,
            EXTRA,
            COLUMN_COMMENT,
            CHARACTER_MAXIMUM_LENGTH,
            NUMERIC_PRECISION
          FROM information_schema.COLUMNS 
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`;
        
        analysis.executedQueries.push(columnsQuery);
        const [columnsResult] = await connection.execute(columnsQuery, [databaseName, tableName]);
        columns = columnsResult as any[];

        // Get sample data only for full detail level
        if (detailLevel === 'full' && sampleDataLimit > 0) {
          const sampleQuery = `SELECT * FROM \`${databaseName}\`.\`${tableName}\` LIMIT ${sampleDataLimit}`;
          analysis.executedQueries.push(sampleQuery);
          const [sampleResult] = await connection.execute(sampleQuery);
          sampleData = sampleResult as any[];
        }
      }

      // Classify table (even for summary mode using basic info)
      const tableAnalysis = this.classifyTableIntelligently(tableName, columns, sampleData, focusArea);
      
      const tableInfo: any = {
        ...table,
        database: databaseName,
        analysis: tableAnalysis
      };

      // Add detailed info based on detail level
      if (detailLevel !== 'summary') {
        tableInfo.columns = columns;
        
        if (detailLevel === 'full') {
          tableInfo.sampleData = sampleData;
          tableInfo.insights = this.generateTableInsights(tableName, table, columns, sampleData, analysis.database.relationships);
        }
      }
      
      analysis.database.tables[tableName] = tableInfo;
    }

    // Generate database summary
    analysis.database.summary = this.generateDatabaseSummary(analysis.database.tables, analysis.database.relationships);

    return analysis;
  }

  private generateDatabaseSummary(tables: any, relationships: any[]) {
    const tableNames = Object.keys(tables);
    const factTables = tableNames.filter(t => tables[t].analysis.relationships.isFactTable);
    const dimTables = tableNames.filter(t => tables[t].analysis.relationships.isDimensionTable);
    const userTables = tableNames.filter(t => tables[t].analysis.relationships.isUserTable);
    const eventTables = tableNames.filter(t => tables[t].analysis.relationships.isEventTable);

    return {
      totalTables: tableNames.length,
      factTables: factTables.length,
      dimensionTables: dimTables.length,
      userTables: userTables.length,
      eventTables: eventTables.length,
      relationships: relationships.length,
      largestTables: tableNames
        .sort((a, b) => (tables[b].TABLE_ROWS || 0) - (tables[a].TABLE_ROWS || 0))
        .slice(0, 5),
      architecture: factTables.length > 0 ? 'star_schema' : 'normalized'
    };
  }

  private analyzeCrossDatabasePatterns(databases: any): any[] {
    const insights = [];
    const dbNames = Object.keys(databases);
    
    // Look for similar table structures across databases
    const tablePatterns: any = {};
    for (const dbName of dbNames) {
      const tables = Object.keys(databases[dbName].tables);
      for (const tableName of tables) {
        if (!tablePatterns[tableName]) tablePatterns[tableName] = [];
        tablePatterns[tableName].push({
          database: dbName,
          analysis: databases[dbName].tables[tableName].analysis
        });
      }
    }

    // Find tables that exist in multiple databases
    for (const [tableName, instances] of Object.entries(tablePatterns) as [string, any[]][]) {
      if (instances.length > 1) {
        insights.push({
          pattern: 'duplicate_table_structure',
          table: tableName,
          databases: instances.map(i => i.database),
          recommendation: `Table '${tableName}' exists in ${instances.length} databases - consider data partitioning strategy`
        });
      }
    }

    // Look for user data spread across databases
    const userDatabases = dbNames.filter(db => 
      databases[db].summary.userTables > 0 || databases[db].summary.eventTables > 0
    );
    
    if (userDatabases.length > 1) {
      insights.push({
        pattern: 'distributed_user_data',
        databases: userDatabases,
        recommendation: 'User data is distributed across multiple databases - consider cross-database user journey analysis'
      });
    }

    return insights;
  }

  private generateMultiDatabaseInsights(databases: any, focusArea: string): any[] {
    const insights = [];
    const dbNames = Object.keys(databases);
    
    insights.push({
      category: 'Server Overview',
      insight: `Analyzed ${dbNames.length} databases with ${Object.values(databases).reduce((sum: number, db: any) => sum + db.summary.totalTables, 0)} total tables`,
      recommendation: `Server contains ${dbNames.join(', ')} - use database.table syntax for cross-database queries`
    });

    // Architecture insights
    const starSchemas = dbNames.filter(db => databases[db].summary.architecture === 'star_schema');
    if (starSchemas.length > 0) {
      insights.push({
        category: 'Analytics Architecture',
        insight: `Star schema detected in: ${starSchemas.join(', ')}`,
        recommendation: 'These databases are optimized for analytical queries and reporting'
      });
    }

    if (focusArea === 'user_behavior') {
      const userDatabases = dbNames.filter(db => databases[db].summary.userTables > 0);
      if (userDatabases.length > 0) {
        insights.push({
          category: 'User Analytics Ready',
          insight: `User data found in: ${userDatabases.join(', ')}`,
          recommendation: 'Perfect setup for cross-database user behavior analysis and journey mapping'
        });
      }
    }

    return insights;
  }

  private generateMultiDatabaseQueries(databases: any, focusArea: string): any[] {
    const queries = [];
    const dbNames = Object.keys(databases);

    // Cross-database user analysis
    if (focusArea === 'user_behavior') {
      const userDatabases = dbNames.filter(db => databases[db].summary.userTables > 0);
      const eventDatabases = dbNames.filter(db => databases[db].summary.eventTables > 0);

      if (userDatabases.length > 0 && eventDatabases.length > 0) {
        queries.push({
          title: 'Cross-Database User Activity',
          description: 'Analyze user activity across multiple databases',
          sql: `-- Example: Cross-database user activity analysis
-- Adjust database and table names according to your schema
SELECT 
  u.user_id,
  u.email,
  COUNT(DISTINCT e1.id) as events_db1,
  COUNT(DISTINCT e2.id) as events_db2
FROM ${userDatabases[0]}.users u
LEFT JOIN ${eventDatabases[0]}.events e1 ON u.user_id = e1.user_id
LEFT JOIN ${eventDatabases.length > 1 ? eventDatabases[1] : eventDatabases[0]}.events e2 ON u.user_id = e2.user_id
GROUP BY u.user_id, u.email
ORDER BY (COUNT(DISTINCT e1.id) + COUNT(DISTINCT e2.id)) DESC`,
          useCase: 'Understanding user engagement across different application components'
        });
      }
    }

    // Database comparison queries
    queries.push({
      title: 'Database Size Comparison',
      description: 'Compare table sizes across databases',
      sql: `SELECT 
  TABLE_SCHEMA as database_name,
  TABLE_NAME,
  TABLE_ROWS,
  ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) AS size_mb
FROM information_schema.TABLES
WHERE TABLE_SCHEMA IN (${dbNames.map(db => `'${db}'`).join(', ')})
ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
LIMIT 20`,
      useCase: 'Identifying largest tables for optimization and resource planning'
    });

    return queries;
  }

  // For Smithery compatibility
  getServer() {
    return this.server;
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('MySQL MCP Server running on stdio');
  }

  async cleanup() {
    // Close all active connections
    for (const [key, connection] of this.connections.entries()) {
      try {
        await connection.end();
        console.error(`Closed connection: ${key}`);
      } catch (error) {
        console.error(`Error closing connection ${key}:`, error);
      }
    }
    this.connections.clear();
  }
}

// Smithery compatibility export
export default function ({ config }: { config: z.infer<typeof configSchema> }) {
  const serverInstance = new MySQLMCPServer(config);
  return serverInstance.getServer();
}

// Traditional standalone server mode (when run directly)
// Check if we're running as the main module (works in both ESM and CommonJS)
const isMainModule = typeof require !== 'undefined' 
  ? require.main === module 
  : import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const server = new MySQLMCPServer();

  process.on('SIGINT', async () => {
    await server.cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.cleanup();
    process.exit(0);
  });

  server.start().catch(console.error);
}
