/**
 * 基础Repository类
 * 提供通用的数据访问方法，所有具体Repository继承此类
 * 纯粹的数据访问，不包含业务逻辑
 */

import { ValidationError } from "../http/errors.js";
import { getDialect } from "../db/dialects/index.js";

export class BaseRepository {
  /**
   * 构造函数
   * @param {D1Database} db - 数据库实例（D1/SQLiteAdapter/未来可扩展）
   * @param {object} [dialect] - 数据库方言对象（用于多数据库扩展）
   */
  constructor(db, dialect = null) {
    this.db = db;
    // KISS：dialect 必须可用，否则默认 sqlite（当前项目主运行形态）
    this.dialect = dialect || getDialect("sqlite");
  }

  /**
   * 构建“插入忽略冲突”的 SQL
   * - 用于替代散落的 INSERT OR IGNORE / INSERT IGNORE / ON CONFLICT DO NOTHING
   * @param {string} table
   * @param {string[]} columns
   */
  _buildInsertIgnoreSql(table, columns) {
    if (!this.dialect?.buildInsertIgnoreSql) {
      throw new ValidationError("当前数据库方言未实现 buildInsertIgnoreSql");
    }
    return this.dialect.buildInsertIgnoreSql({ table, columns });
  }

  /**
   * 根据ID查找记录
   * @param {string} table - 表名
   * @param {string} id - 记录ID
   * @returns {Promise<Object|null>} 记录对象或null
   */
  async findById(table, id) {
    if (!id) return null;
    
    return await this.db
      .prepare(`SELECT * FROM ${table} WHERE id = ?`)
      .bind(id)
      .first();
  }

  /**
   * 根据条件查找单条记录
   * @param {string} table - 表名
   * @param {Object} conditions - 查询条件 {field: value}
   * @returns {Promise<Object|null>} 记录对象或null
   */
  async findOne(table, conditions) {
    const fields = Object.keys(conditions);
    const values = Object.values(conditions);
    
    if (fields.length === 0) return null;
    
    const whereClause = fields.map(field => `${field} = ?`).join(' AND ');
    
    return await this.db
      .prepare(`SELECT * FROM ${table} WHERE ${whereClause}`)
      .bind(...values)
      .first();
  }

  /**
   * 根据条件查找多条记录
   * @param {string} table - 表名
   * @param {Object} conditions - 查询条件 {field: value}
   * @param {Object} options - 查询选项 {orderBy, limit, offset}
   * @returns {Promise<Array>} 记录数组
   */
  async findMany(table, conditions = {}, options = {}) {
    // 过滤条件既支持等值（{ field: value }），也支持操作符对象
    // （{ field: { "!=": 1 } } / { ">=": 3 } / { in: [..] } / { is: null }）。
    // 之前只按等值拼接 SQL，操作符对象会被整体当作绑定参数，D1 会直接报
    // D1_TYPE_ERROR: Type 'object' not supported。
    const buildCondition = (field, value) => {
      const operators = {
        '!=': '!=',
        '>': '>',
        '<': '<',
        '>=': '>=',
        '<=': '<=',
        'like': 'LIKE',
        'not like': 'NOT LIKE',
      };

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value);
        if (keys.length !== 1) {
          throw new ValidationError(`过滤条件 ${field} 只能包含一个操作符`);
        }
        const operator = keys[0];
        const raw = value[operator];

        if (operator === 'in') {
          if (!Array.isArray(raw) || raw.length === 0) {
            // 空集合等价于不命中任何行
            return { clause: '1 = 0', values: [] };
          }
          return {
            clause: `${field} IN (${raw.map(() => '?').join(', ')})`,
            values: [...raw],
          };
        }
        if (operator === 'is' || operator === 'is not') {
          if (raw !== null) {
            throw new ValidationError(`过滤条件 ${field} 的 ${operator} 只支持 null`);
          }
          return { clause: `${field} ${operator.toUpperCase()} NULL`, values: [] };
        }
        const sqlOperator = operators[operator];
        if (!sqlOperator) {
          throw new ValidationError(`不支持的过滤操作符: ${operator}`);
        }
        return { clause: `${field} ${sqlOperator} ?`, values: [raw] };
      }

      if (value === null) {
        return { clause: `${field} IS NULL`, values: [] };
      }

      return { clause: `${field} = ?`, values: [value] };
    };

    const fields = Object.keys(conditions);
    const built = fields.map((field) => buildCondition(field, conditions[field]));
    const values = built.flatMap((item) => item.values);

    let sql = `SELECT * FROM ${table}`;

    if (built.length > 0) {
      const whereClause = built.map((item) => item.clause).join(' AND ');
      sql += ` WHERE ${whereClause}`;
    }
    
    if (options.orderBy) {
      sql += ` ORDER BY ${options.orderBy}`;
    }
    
    if (options.limit) {
      sql += ` LIMIT ${options.limit}`;
      if (options.offset) {
        sql += ` OFFSET ${options.offset}`;
      }
    }
    
    const result = await this.db
      .prepare(sql)
      .bind(...values)
      .all();
      
    return result.results || [];
  }

  /**
   * 创建记录
   * @param {string} table - 表名
   * @param {Object} data - 数据对象
   * @returns {Promise<Object>} 执行结果
   */
  async create(table, data) {
    const fields = Object.keys(data);
    const values = Object.values(data);
    
    if (fields.length === 0) {
      throw new ValidationError('创建记录时数据不能为空');
    }
    
    const fieldsClause = fields.join(', ');
    const placeholders = fields.map(() => '?').join(', ');
    
    return await this.db
      .prepare(`INSERT INTO ${table} (${fieldsClause}) VALUES (${placeholders})`)
      .bind(...values)
      .run();
  }

  /**
   * 更新记录
   * @param {string} table - 表名
   * @param {string} id - 记录ID
   * @param {Object} data - 更新数据
   * @returns {Promise<Object>} 执行结果
   */
  async update(table, id, data) {
    const fields = Object.keys(data);
    const values = Object.values(data);
    
    if (fields.length === 0) {
      throw new ValidationError('更新记录时数据不能为空');
    }
    
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    
    return await this.db
      .prepare(`UPDATE ${table} SET ${setClause} WHERE id = ?`)
      .bind(...values, id)
      .run();
  }

  /**
   * 删除记录
   * @param {string} table - 表名
   * @param {string} id - 记录ID
   * @returns {Promise<Object>} 执行结果
   */
  async delete(table, id) {
    return await this.db
      .prepare(`DELETE FROM ${table} WHERE id = ?`)
      .bind(id)
      .run();
  }

  /**
   * 根据条件删除记录
   * @param {string} table - 表名
   * @param {Object} conditions - 删除条件
   * @returns {Promise<Object>} 执行结果
   */
  async deleteWhere(table, conditions) {
    const fields = Object.keys(conditions);
    const values = Object.values(conditions);
    
    if (fields.length === 0) {
      throw new ValidationError('删除记录时条件不能为空');
    }
    
    const whereClause = fields.map(field => `${field} = ?`).join(' AND ');
    
    return await this.db
      .prepare(`DELETE FROM ${table} WHERE ${whereClause}`)
      .bind(...values)
      .run();
  }

  /**
   * 计算记录数量
   * @param {string} table - 表名
   * @param {Object} conditions - 查询条件
   * @returns {Promise<number>} 记录数量
   */
  async count(table, conditions = {}) {
    const fields = Object.keys(conditions);
    const values = Object.values(conditions);
    
    let sql = `SELECT COUNT(*) as count FROM ${table}`;
    
    if (fields.length > 0) {
      const whereClause = fields.map(field => `${field} = ?`).join(' AND ');
      sql += ` WHERE ${whereClause}`;
    }
    
    const result = await this.db
      .prepare(sql)
      .bind(...values)
      .first();
      
    return result?.count || 0;
  }

  /**
   * 检查记录是否存在
   * @param {string} table - 表名
   * @param {Object} conditions - 查询条件
   * @returns {Promise<boolean>} 是否存在
   */
  async exists(table, conditions) {
    const count = await this.count(table, conditions);
    return count > 0;
  }

  /**
   * 执行自定义SQL查询
   * @param {string} sql - SQL语句
   * @param {Array} params - 参数数组
   * @returns {Promise<Object>} 查询结果
   */
  async query(sql, params = []) {
    return await this.db
      .prepare(sql)
      .bind(...params)
      .all();
  }

  /**
   * 执行自定义SQL查询（单条记录）
   * @param {string} sql - SQL语句
   * @param {Array} params - 参数数组
   * @returns {Promise<Object|null>} 查询结果
   */
  async queryFirst(sql, params = []) {
    return await this.db
      .prepare(sql)
      .bind(...params)
      .first();
  }

  /**
   * 执行自定义SQL（增删改）
   * @param {string} sql - SQL语句
   * @param {Array} params - 参数数组
   * @returns {Promise<Object>} 执行结果
   */
  async execute(sql, params = []) {
    return await this.db
      .prepare(sql)
      .bind(...params)
      .run();
  }
}
