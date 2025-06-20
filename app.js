const { createApp, ref, onMounted } = Vue;

createApp({
  setup() {
    const days = ref([]);
    const newTasks = ref({});

    // Initialiser les 14 jours (aujourd'hui + 13 suivants)
    const initDays = () => {
      const today = new Date();
      const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
      
      for (let i = 0; i < 14; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);
        
        const formattedDate = date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'numeric' });
        const dayName = dayNames[date.getDay()];
        
        days.value.push({
          name: dayName,
          date: formattedDate,
          tasks: JSON.parse(localStorage.getItem(`tasks_${formattedDate}`)) || []
        });
      }
    };

    // Ajouter une tâche
    const addTask = (date) => {
      const taskText = newTasks.value[date]?.trim();
      if (!taskText) return;
      
      const day = days.value.find(d => d.date === date);
      day.tasks.push(taskText);
      localStorage.setItem(`tasks_${date}`, JSON.stringify(day.tasks));
      newTasks.value[date] = '';
    };

    // Supprimer une tâche
    const deleteTask = (date, taskIndex) => {
      const day = days.value.find(d => d.date === date);
      day.tasks.splice(taskIndex, 1);
      localStorage.setItem(`tasks_${date}`, JSON.stringify(day.tasks));
    };

    onMounted(() => {
      initDays();
      
      // Activer le drag & drop
      document.querySelectorAll('.task-list').forEach(list => {
        new Sortable(list, {
          group: 'tasks',
          animation: 150,
          onEnd: (evt) => {
            const fromDate = evt.from.getAttribute('data-date');
            const toDate = evt.to.getAttribute('data-date');
            
            const fromDay = days.value.find(d => d.date === fromDate);
            const toDay = days.value.find(d => d.date === toDate);
            
            const [movedTask] = fromDay.tasks.splice(evt.oldIndex, 1);
            toDay.tasks.splice(evt.newIndex, 0, movedTask);
            
            localStorage.setItem(`tasks_${fromDate}`, JSON.stringify(fromDay.tasks));
            localStorage.setItem(`tasks_${toDate}`, JSON.stringify(toDay.tasks));
          }
        });
      });
    });

    return { 
      days, 
      newTasks, 
      addTask,
      deleteTask
    };
  }
}).mount('#app');