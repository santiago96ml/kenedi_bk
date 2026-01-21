const supabase = require('../config/supabase');

class BotService {
  
  async getSettings() {
    // Asumimos que la configuración principal es siempre el ID 1
    const { data, error } = await supabase
      .from('bot_settings')
      .select('*')
      .eq('id', 1)
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  async updateSettings(settings) {
    const { is_active, welcome_message, away_message } = settings;
    
    const { data, error } = await supabase
      .from('bot_settings')
      .update({ 
        is_active, 
        welcome_message, 
        away_message, 
        updated_at: new Date() 
      })
      .eq('id', 1)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }
}

module.exports = new BotService();