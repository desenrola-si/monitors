INSERT INTO alert_types (code, description) VALUES
  ('crm_automation_step_failed', 'Passos de automação do CRM falhando — cliente espera mensagem que nunca vem'),
  ('crm_automation_step_overdue', 'Passos de automação atrasados — agendados há mais de 1h e ainda pendentes'),
  ('reservation_duplicate', 'Mesmo cliente com mais de uma reserva criada em poucos minutos'),
  ('reservation_outside_slot', 'Reserva final difere significativamente do horário pedido pelo cliente'),
  ('session_abandoned_midflow', 'Atendimento aberto sem resposta há horas — cliente esperando')
ON CONFLICT (code) DO NOTHING;
